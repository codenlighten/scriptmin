'use strict'

// What mainnet locking scripts are made of, and what scriptmin would save.
//
//   node examples/mainnet-survey.js collect [--blocks 240] [--tx 400] [--seconds 540]
//   node examples/mainnet-survey.js report  [--effort medium]
//
// `collect` samples blocks evenly from the Genesis upgrade to the chain tip
// through WhatsOnChain's public API, and records every output's locking script:
// standard ones as a class and a count, the rest in full. One file per block
// under .survey/, so it resumes where it stopped; the public API is paced, so a
// full sample takes about twenty minutes.
//
// `report` groups the non-standard scripts into templates (opcodes kept, data
// pushes replaced by their size), optimizes one script per template, and prints
// what that would save, weighted by how often the template appears.
//
// Nothing here spends, broadcasts or needs a key: it only reads public data.

const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')
const bsv = require('@smartledger/bsv')
const { optimize } = require('../src')
const { parse, toAsm, isPush, pushValue, TAIL, DEAD, standardTemplate } = require('../src/script')

const DIR = path.join(__dirname, '..', '.survey')
const GENESIS = 620538 // the Genesis upgrade, February 2020
const HOST = 'api.whatsonchain.com'
const BASE = '/v1/bsv/main'
const MIN_GAP_MS = 350

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i < 0 ? dflt : process.argv[i + 1]
}

let lastCall = 0
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function request (method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = https.request({
      host: HOST,
      path: BASE + p,
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        if (res.statusCode >= 400) return reject(new Error(`${res.statusCode} on ${p}: ${text.slice(0, 120)}`))
        try { resolve(JSON.parse(text)) } catch (e) { resolve(text) }
      })
    })
    req.setTimeout(60000, () => req.destroy(new Error('timeout on ' + p)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// Paced and retried: this is someone else's public API.
async function api (method, p, body) {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now())
    if (wait) await sleep(wait)
    lastCall = Date.now()
    try {
      return await request(method, p, body)
    } catch (e) {
      if (attempt >= 5 || !/^(429|5\d\d)|timeout|ECONNRESET|socket/.test(e.message)) throw e
      await sleep(1000 * 2 ** attempt)
    }
  }
}

// Standard templates plus the shapes built from them, so that "other" means a
// script someone wrote rather than a wallet's output.
function classify (buf) {
  const std = standardTemplate(buf)
  if (std) return std
  if (buf.length === 0) return 'empty'
  const hex = buf.toString('hex')
  if (hex.includes('0063036f7264') && /76a914[0-9a-f]{40}88ac/.test(hex)) {
    const stripped = hex.replace(/0063036f7264[0-9a-f]*68$/, '').replace(/^0063036f7264[0-9a-f]*?68(?=76a914)/, '')
    if (/^76a914[0-9a-f]{40}88ac$/.test(stripped)) return 'P2PKH + inscription'
  }
  if (/^76a914[0-9a-f]{40}88ac6a/.test(hex)) return 'P2PKH + data'
  return 'other'
}

async function sampleBlock (height, maxTx) {
  const file = path.join(DIR, height + '.json')
  if (fs.existsSync(file)) return false
  const b = await api('GET', '/block/height/' + height)
  let txids = b.tx || []
  if (b.pages && b.pages.size) {
    // A large block lists its txids in pages; take up to four at random.
    txids = []
    const pages = new Set()
    while (pages.size < Math.min(4, b.pages.size)) pages.add(1 + crypto.randomInt(b.pages.size))
    for (const page of pages) {
      const more = await api('GET', `/block/hash/${b.hash}/page/${page}`)
      if (Array.isArray(more)) txids.push(...more)
    }
  }
  const picked = txids.length > maxTx
    ? txids.map(t => [crypto.randomInt(1e9), t]).sort((x, y) => x[0] - y[0]).slice(0, maxTx).map(x => x[1])
    : txids
  const counts = {}
  const bytes = {}
  const others = {}
  let outputs = 0
  for (let i = 0; i < picked.length; i += 20) {
    const res = await api('POST', '/txs/hex', { txids: picked.slice(i, i + 20) })
    for (const r of res) {
      if (!r.hex) continue
      let tx
      try { tx = new bsv.Transaction(r.hex) } catch (e) { continue }
      for (const o of tx.outputs) {
        const s = o.script.toBuffer()
        const c = classify(s)
        outputs++
        counts[c] = (counts[c] || 0) + 1
        bytes[c] = (bytes[c] || 0) + s.length
        if (c === 'other' || c === 'bare multisig' || c === 'P2PKH + data') {
          const k = crypto.createHash('sha256').update(s).digest('hex')
          if (!others[k]) others[k] = { hex: s.length <= 2e6 ? s.toString('hex') : null, size: s.length, n: 0, cls: c, txid: r.txid }
          others[k].n++
        }
      }
    }
  }
  fs.writeFileSync(file, JSON.stringify({ height, hash: b.hash, time: b.time, size: b.size, txcount: b.txcount || txids.length, sampled: picked.length, outputs, counts, bytes, others }))
  return true
}

async function collect () {
  fs.mkdirSync(DIR, { recursive: true })
  const nblocks = Number(arg('blocks', 240))
  const maxTx = Number(arg('tx', 400))
  const stopAt = Date.now() + Number(arg('seconds', 540)) * 1000
  // The tip is pinned in .survey/tip so that resuming picks the same blocks.
  const tipFile = path.join(DIR, 'tip')
  let tip
  if (fs.existsSync(tipFile)) tip = Number(fs.readFileSync(tipFile, 'utf8'))
  else {
    tip = (await api('GET', '/chain/info')).blocks - 6
    fs.writeFileSync(tipFile, String(tip))
  }
  const heights = []
  for (let i = 0; i < nblocks; i++) heights.push(Math.round(GENESIS + (tip - GENESIS) * (i + 0.5) / nblocks))
  let done = 0
  let had = 0
  for (const h of heights) {
    if (Date.now() > stopAt) break
    try {
      if (await sampleBlock(h, maxTx)) done++
      else had++
    } catch (e) {
      console.error('block', h, e.message)
    }
  }
  console.log(`fetched ${done}, already had ${had}, of ${heights.length} blocks up to height ${tip}`)
  if (done + had < heights.length) console.log('run again to continue')
}

// Opcodes as they are, pushes of 8 bytes or more as <data>, verbatim blocks as
// what they are: two scripts share a template when they are the same code.
function templateOf (buf) {
  return parse(buf).map(o => {
    if (o.code === TAIL) return '<tail>'
    if (o.code === DEAD) return '<envelope>'
    if (isPush(o) && pushValue(o).length >= 8) return '<data>'
    return toAsm([o])
  }).join(' ')
}

function report () {
  if (!fs.existsSync(DIR)) { console.error('no .survey directory: run "collect" first'); process.exit(2) }
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'))
  const blocks = files.map(f => JSON.parse(fs.readFileSync(path.join(DIR, f))))
  const counts = {}
  const bytes = {}
  const others = new Map()
  let outputs = 0
  let txs = 0
  for (const b of blocks) {
    outputs += b.outputs
    txs += b.sampled
    for (const [k, v] of Object.entries(b.counts)) counts[k] = (counts[k] || 0) + v
    for (const [k, v] of Object.entries(b.bytes)) bytes[k] = (bytes[k] || 0) + v
    for (const [h, o] of Object.entries(b.others)) {
      const e = others.get(h) || Object.assign({}, o, { n: 0 })
      e.n += o.n
      others.set(h, e)
    }
  }
  const total = Object.values(bytes).reduce((a, x) => a + x, 0)
  console.log(`${blocks.length} blocks, ${txs} transactions, ${outputs} outputs, ${total} bytes of locking script\n`)
  console.log('class'.padEnd(22) + 'outputs'.padStart(9) + '%'.padStart(7) + 'bytes'.padStart(12) + '%'.padStart(7))
  for (const c of Object.keys(counts).sort((a, b) => bytes[b] - bytes[a])) {
    console.log(c.padEnd(22) + String(counts[c]).padStart(9) + (100 * counts[c] / outputs).toFixed(1).padStart(7) +
      String(bytes[c]).padStart(12) + (100 * bytes[c] / total).toFixed(1).padStart(7))
  }

  const templates = new Map()
  let hugeCount = 0
  let hugeBytes = 0
  for (const o of others.values()) {
    // Scripts over 2 MB are counted but not stored: they are inscriptions, all data.
    if (!o.hex) { hugeCount += o.n; hugeBytes += o.size * o.n; continue }
    const buf = Buffer.from(o.hex, 'hex')
    let t
    try { t = templateOf(buf) } catch (e) { t = 'unparseable' }
    const e = templates.get(t) || { t, n: 0, bytes: 0, example: buf, txid: o.txid }
    e.n += o.n
    e.bytes += o.size * o.n
    templates.set(t, e)
  }
  const effort = arg('effort', 'medium')
  console.log(`\n${templates.size} templates among the non-standard scripts; optimizing one script of each at --effort ${effort}\n`)
  console.log('outputs'.padStart(8) + 'bytes'.padStart(10) + 'saved'.padStart(9) + '  kept  template')
  let before = 0
  let after = 0
  const rows = [...templates.values()].sort((a, b) => b.bytes - a.bytes)
  for (const e of rows) {
    let r
    try {
      r = optimize(e.example, { effort, differential: 20 })
    } catch (err) {
      console.log(String(e.n).padStart(8) + String(e.example.length).padStart(10) + '        -' + '       ' + err.message.slice(0, 40))
      continue
    }
    const saved = (e.example.length - r.script.length) * e.n
    before += e.bytes
    after += e.bytes - saved
    const kept = r.report.kept.template || (r.report.kept.dataPushes ? r.report.kept.dataPushes + ' data' : '')
    console.log(String(e.n).padStart(8) + String(e.example.length).padStart(10) + String(saved).padStart(9) + '  ' +
      kept.padEnd(6) + '  ' + (e.t.length > 70 ? e.t.slice(0, 70) + '…' : e.t))
  }
  if (!before) { console.log('\nno non-standard scripts in this sample'); return }
  if (hugeCount) console.log(`\n${hugeCount} script${hugeCount === 1 ? '' : 's'} over 2 MB (${hugeBytes} bytes) were counted but not kept, so not optimized here`)
  console.log(`\nnon-standard scripts: ${before} -> ${after} bytes (${(100 * (before - after) / before).toFixed(1)}%)`)
  console.log(`all locking scripts:  ${(100 * (before - after) / total).toFixed(2)}% of ${total} bytes`)
  console.log('Savings are code only: data and standard templates are kept (see README).')
}

const cmd = process.argv[2]
if (cmd === 'collect') collect().catch(e => { console.error(e.message); process.exit(1) })
else if (cmd === 'report') report()
else { console.error('usage: mainnet-survey.js collect|report [options]'); process.exit(2) }
