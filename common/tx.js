/* Thin wrapper around the Tableau Extensions API for viz extensions.
   - TX.start(onData)  : initialise, then call onData({rows, enc, fields}) now and whenever the summary data changes
   - rows : array of { "<field name>": {value, formattedValue}, ... }  (one per mark)
   - enc  : { "<encoding id from the .trex>": [field, ...] }  only encodings with fields dropped on them
   Opening the page with ?demo=1 outside Tableau uses a demo loader instead (for local testing). */
(function () {
  'use strict';
  const demo = /[?&]demo/.test(location.search);

  function parseCSV(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (ch !== '\r') f += ch;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    const head = rows.shift();
    return rows.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }
  const cell = (v, formatted) => ({ value: v, formattedValue: formatted == null ? String(v) : formatted });

  async function getEncodings(ws) {
    const spec = await ws.getVisualSpecificationAsync();
    const out = {};
    if (spec.activeMarksSpecificationIndex < 0) return out;
    const mc = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    for (const e of mc.encodings) (out[e.id] = out[e.id] || []).push(e.field);
    return out;
  }
  async function getRows(ws) {
    let rows = [], cols = [];
    const reader = await ws.getSummaryDataReaderAsync(undefined, { ignoreSelection: true });
    for (let p = 0; p < reader.pageCount; p++) {
      const page = await reader.getPageAsync(p);
      if (!cols.length) cols = page.columns.map(c => ({ name: c.fieldName, dataType: c.dataType }));
      for (const d of page.data) {
        const o = {};
        for (const col of page.columns) o[col.fieldName] = d[col.index];
        rows.push(o);
      }
    }
    await reader.releaseAsync();
    if (!cols.length) {          // a filter left no rows, so there was no page to read the columns from: ask for the column list on its own
      try { const t = await ws.getSummaryDataAsync({ ignoreSelection: true, maxRows: 1 }); cols = t.columns.map(c => ({ name: c.fieldName, dataType: c.dataType })); } catch (e) { /* the extension keeps the last known columns instead */ }
    }
    return { rows, cols };
  }

  const readyFns = [];
  const stage = { s: 'page loaded', at: Date.now() }; const setStage = t => { stage.s = t; stage.at = Date.now(); };
  const TX = {
    demo, parseCSV, cell, stage,
    /* run fn once the Extensions API is initialised (saved settings are only readable from then on) */
    ready(fn) { readyFns.push(fn); },
    /* 'authoring' (the workbook author, in Desktop or web edit), 'viewing' (someone just using it), or '' if unknown. In the browser demo ?mode=viewing pretends to be a viewer. */
    mode() { if (demo) return (location.search.match(/[?&]mode=(\w+)/) || [])[1] || 'demo'; try { return tableau.extensions.environment.mode || ''; } catch (e) { return ''; } },
    async fetchCSV(path) { return parseCSV(await (await fetch(path)).text()); },
    /* Settings live in the workbook. Tableau locks them while a save is running (set() then throws), so values are queued here,
       written together, and saved one save at a time. TX.settings.save() returns a promise that rejects if the save failed.
       Every value is also copied to this browser's local storage, and any key the workbook turns out to be missing is put back from that copy. */
    settings: (() => {
      const pending = {}; let timer = 0, chain = Promise.resolve();
      const info = { loaded: null, restored: [], last: null };
      const bkey = () => { try { const e = tableau.extensions, n = (e.dashboardContent && e.dashboardContent.dashboard.name) || (e.worksheetContent && e.worksheetContent.worksheet.name) || ''; return 'tx-backup:' + location.pathname + ':' + n; } catch (e) { return null; } };
      const readB = () => { try { const k = bkey(); return k ? JSON.parse(localStorage.getItem(k) || '{}') : {}; } catch (e) { return {}; } };
      const writeB = (k, v) => { try { const key = bkey(); if (!key) return; const o = readB(); o[k] = v; localStorage.setItem(key, JSON.stringify(o)); } catch (e) { /* storage not available */ } };
      const flush = () => { chain = chain.then(async () => {
        const keys = Object.keys(pending); if (!keys.length) return;
        const s = tableau.extensions.settings, batch = {}; keys.forEach(k => { batch[k] = pending[k]; delete pending[k]; });
        try { keys.forEach(k => s.set(k, batch[k])); for (let a = 0; ; a++) { try { await s.saveAsync(); break; } catch (e) { if (a >= 3) throw e; await new Promise(r => setTimeout(r, 1000 * (a + 1))); } }      // Tableau sometimes refuses a save for a moment: try again a few times
          info.last = { ok: true, at: new Date(), keys: Object.keys(s.getAll()).length }; if (api.onSaved) api.onSaved(); }
        catch (err) { keys.forEach(k => { if (!(k in pending)) pending[k] = batch[k]; }); info.last = { ok: false, at: new Date(), error: String(err && err.message || err) }; if (api.onSaved) api.onSaved(); throw err; }      // keep the values so the next save retries them
      }); const p = chain; chain = chain.catch(() => {}); return p; };
      const api = {
        onError: null, onSaved: null, info,
        get(k, dflt) { if (k in pending) return pending[k]; try { const v = tableau.extensions.settings.get(k); return v == null ? dflt : v; } catch (e) { return dflt; } },
        set(k, v) { pending[k] = v; writeB(k, v); clearTimeout(timer); timer = setTimeout(() => { api.save().catch(err => { console.error('Could not save settings', err); if (api.onError) api.onError(err); clearTimeout(timer); timer = setTimeout(() => api.save().catch(() => {}), 8000); }); }, 300); },
        save() { clearTimeout(timer); if (demo) { Object.keys(pending).forEach(k => delete pending[k]); return Promise.resolve(); } return flush(); },
        restore() {          // call once the Extensions API is ready: fill in whatever the workbook lacks from the local copy
          if (demo) return;
          try {
            const have = tableau.extensions.settings.getAll(), b = readB(); info.loaded = Object.keys(have).length;
            info.restored = Object.keys(b).filter(k => !(k in have));
            info.restored.forEach(k => { pending[k] = b[k]; });
            if (info.restored.length) { clearTimeout(timer); timer = setTimeout(() => api.save().catch(() => {}), 300); }      // and put them back into the workbook
          } catch (e) { /* ignore */ }
        }
      };
      return api;
    })(),
    /* dashboard extension: onData({ sheets: { "<sheet name>": { rows, cols } } }) for every sheet on the dashboard, now and whenever one changes */
    async startDashboard(onData, demoLoader) {
      if (demo) { onData(await demoLoader()); return; }
      setStage('waiting for Tableau to initialise the extension'); try { await tableau.extensions.initializeAsync(); }
      catch (err) { onData({ error: 'Could not initialise the Tableau Extensions API: ' + err }); return; }
      setStage('initialised, reading the sheets'); TX.settings.restore();
      readyFns.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
      const dash = tableau.extensions.dashboardContent.dashboard;
      let busy = false, again = false;
      const refresh = async () => {
        if (busy) { again = true; return; }
        busy = true;
        try {
          const sheets = {};
          for (const ws of dash.worksheets) {
            try { sheets[ws.name] = await getRows(ws); } catch (err) { sheets[ws.name] = { rows: [], cols: [], error: String(err) }; }
          }
          onData({ sheets });
        } catch (err) { onData({ error: String(err) }); }
        busy = false;
        if (again) { again = false; refresh(); }
      };
      dash.worksheets.forEach(ws => ws.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh));
      refresh();
    },
    async start(onData, demoLoader) {
      if (demo) { onData(await demoLoader()); return; }
      setStage('waiting for Tableau to initialise the extension'); try {
        await tableau.extensions.initializeAsync();
      } catch (err) { onData({ error: 'Could not initialise the Tableau Extensions API: ' + err }); return; }
      setStage('initialised, reading the sheets'); TX.settings.restore();
      readyFns.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
      const ws = tableau.extensions.worksheetContent.worksheet;
      let busy = false, again = false;
      const refresh = async () => {
        if (busy) { again = true; return; }
        busy = true; const t0 = Date.now(); if (TX.onRefresh) TX.onRefresh('start');
        try {
          const [enc, data] = await Promise.all([getEncodings(ws), getRows(ws)]);
          if (TX.onRefresh) TX.onRefresh('read', { rows: data.rows.length, s: (Date.now() - t0) / 1000 });
          onData({ rows: data.rows, cols: data.cols, enc });
        } catch (err) { onData({ error: String(err) }); }
        if (TX.onRefresh) TX.onRefresh('done', { s: (Date.now() - t0) / 1000 });
        busy = false;
        if (again) { again = false; refresh(); }
      };
      ws.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh);
      refresh();
    }
  };
  window.TX = TX;
})();
