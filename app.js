/* Service Motor - frontend (vanilla JavaScript)
 *
 * Bicara ke backend Python lewat REST API (/api/...).
 * Jika backend tidak bisa dihubungi (mis. halaman dibuka sebagai artifact
 * atau file lokal), aplikasi otomatis pindah ke "mode lokal" dan menyimpan
 * data di browser (localStorage) dengan logika pengingat yang sama.
 */
(() => {
  "use strict";

  // Alamat backend. Kosong = origin yang sama (saat disajikan oleh server.py).
  const API_BASE = window.SERVICE_MOTOR_API ?? "";

  const SERVICE_TYPES_DEFAULT = [
    { jenis: "Ganti oli mesin", interval_km: 2000, interval_hari: 60 },
    { jenis: "Ganti oli gardan", interval_km: 8000, interval_hari: 240 },
    { jenis: "Servis berkala / tune up", interval_km: 4000, interval_hari: 120 },
    { jenis: "Servis CVT", interval_km: 8000, interval_hari: 240 },
    { jenis: "Ganti busi", interval_km: 8000, interval_hari: 365 },
    { jenis: "Ganti filter udara", interval_km: 12000, interval_hari: 365 },
    { jenis: "Cek / ganti kampas rem", interval_km: 10000, interval_hari: 365 },
    { jenis: "Ganti air radiator", interval_km: 12000, interval_hari: 365 },
    { jenis: "Lainnya", interval_km: 0, interval_hari: 0 },
  ];
  const SOON_KM = 300;
  const SOON_DAYS = 7;

  // ------------------------------------------------------------------ //
  // Util
  // ------------------------------------------------------------------ //
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtNum = (n) => (n == null ? "-" : Number(n).toLocaleString("id-ID"));
  const fmtRp = (n) => "Rp " + fmtNum(n || 0);
  const fmtDate = (iso) =>
    iso ? new Date(iso + "T00:00:00").toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "-";
  const todayIso = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };

  function toast(msg, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast" + (isError ? " error" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), 2600);
  }

  function askConfirm(msg) {
    return new Promise((resolve) => {
      const box = $("#confirm");
      $("#confirm-msg").textContent = msg;
      box.classList.remove("hidden");
      const done = (v) => {
        box.classList.add("hidden");
        $("#confirm-yes").onclick = $("#confirm-no").onclick = null;
        resolve(v);
      };
      $("#confirm-yes").onclick = () => done(true);
      $("#confirm-no").onclick = () => done(false);
      $("#confirm-yes").focus();
    });
  }

  // ------------------------------------------------------------------ //
  // Backend: REST API
  // ------------------------------------------------------------------ //
  const RemoteStore = {
    async req(method, path, body) {
      const res = await fetch(API_BASE + path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    serviceTypes: () => RemoteStore.req("GET", "/api/service-types"),
    listMotors: () => RemoteStore.req("GET", "/api/motors"),
    getMotor: (id) => RemoteStore.req("GET", `/api/motors/${id}`),
    createMotor: (m) => RemoteStore.req("POST", "/api/motors", m),
    updateMotor: (id, m) => RemoteStore.req("PUT", `/api/motors/${id}`, m),
    deleteMotor: (id) => RemoteStore.req("DELETE", `/api/motors/${id}`),
    listServices: (motorId) => RemoteStore.req("GET", `/api/motors/${motorId}/services`),
    createService: (s) => RemoteStore.req("POST", "/api/services", s),
    deleteService: (id) => RemoteStore.req("DELETE", `/api/services/${id}`),
    reminders: () => RemoteStore.req("GET", "/api/reminders"),
  };

  // ------------------------------------------------------------------ //
  // Mode lokal: localStorage dengan logika sama seperti backend
  // ------------------------------------------------------------------ //
  const LS_KEY = "service-motor-v1";
  let memoryFallback = null; // jika localStorage diblokir

  function loadLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {
      if (memoryFallback) return memoryFallback;
    }
    return memoryFallback || { motors: [], services: [], nextId: 1 };
  }
  function saveLocal(db) {
    memoryFallback = db;
    try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch (_) { /* tetap di memori */ }
  }
  function nowIso() { return new Date().toISOString().slice(0, 19); }

  function validateMotor(m, partial = false) {
    const out = {};
    if (!partial || "nama" in m) {
      if (!String(m.nama || "").trim()) throw new Error("'nama' wajib diisi");
      out.nama = String(m.nama).trim();
    }
    if (!partial || "plat" in m) out.plat = String(m.plat || "").trim().toUpperCase();
    if (!partial || "merk" in m) out.merk = String(m.merk || "").trim();
    if (!partial || "tahun" in m) out.tahun = m.tahun ? parseInt(m.tahun, 10) : null;
    if (!partial || "km_sekarang" in m) {
      const km = parseInt(m.km_sekarang || 0, 10);
      if (isNaN(km) || km < 0) throw new Error("'km_sekarang' harus angka ≥ 0");
      out.km_sekarang = km;
    }
    return out;
  }

  function computeReminders(db, motorId = null) {
    const today = new Date(todayIso() + "T00:00:00");
    const latest = new Map();
    for (const s of db.services) {
      if (motorId != null && s.motor_id !== motorId) continue;
      if (!s.interval_km && !s.interval_hari) continue;
      const key = s.motor_id + "|" + s.jenis;
      const cur = latest.get(key);
      if (!cur || s.tanggal > cur.tanggal || (s.tanggal === cur.tanggal && (s.km > cur.km || (s.km === cur.km && s.id > cur.id))))
        latest.set(key, s);
    }
    const out = [];
    for (const s of latest.values()) {
      const m = db.motors.find((x) => x.id === s.motor_id);
      if (!m) continue;
      const dueKm = s.interval_km ? s.km + s.interval_km : null;
      let dueDate = null;
      if (s.interval_hari) {
        dueDate = new Date(s.tanggal + "T00:00:00");
        dueDate.setDate(dueDate.getDate() + s.interval_hari);
      }
      const sisaKm = dueKm != null ? dueKm - m.km_sekarang : null;
      const sisaHari = dueDate ? Math.round((dueDate - today) / 86400000) : null;
      let status = "ok";
      if ((sisaKm != null && sisaKm <= 0) || (sisaHari != null && sisaHari <= 0)) status = "terlambat";
      else if ((sisaKm != null && sisaKm <= SOON_KM) || (sisaHari != null && sisaHari <= SOON_DAYS)) status = "segera";
      out.push({
        motor_id: m.id, motor_nama: m.nama, motor_plat: m.plat, jenis: s.jenis,
        servis_terakhir_tanggal: s.tanggal, servis_terakhir_km: s.km, km_sekarang: m.km_sekarang,
        jatuh_tempo_km: dueKm,
        jatuh_tempo_tanggal: dueDate
          ? new Date(dueDate.getTime() - dueDate.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
          : null,
        sisa_km: sisaKm, sisa_hari: sisaHari, status,
      });
    }
    const order = { terlambat: 0, segera: 1, ok: 2 };
    const big = 1e9;
    out.sort((a, b) => order[a.status] - order[b.status] || (a.sisa_km ?? big) - (b.sisa_km ?? big) || (a.sisa_hari ?? big) - (b.sisa_hari ?? big));
    return out;
  }

  const LocalStore = {
    async serviceTypes() { return SERVICE_TYPES_DEFAULT; },
    async listMotors() {
      const db = loadLocal();
      return db.motors.map((m) => {
        const sv = db.services.filter((s) => s.motor_id === m.id);
        return {
          ...m,
          jumlah_servis: sv.length,
          total_biaya: sv.reduce((t, s) => t + (s.biaya || 0), 0),
          servis_terakhir: sv.reduce((mx, s) => (!mx || s.tanggal > mx ? s.tanggal : mx), null),
        };
      });
    },
    async getMotor(id) {
      const m = loadLocal().motors.find((x) => x.id === id);
      if (!m) throw new Error("Motor tidak ditemukan");
      return m;
    },
    async createMotor(data) {
      const db = loadLocal();
      const m = { id: db.nextId++, ...validateMotor(data), created_at: nowIso() };
      db.motors.push(m);
      saveLocal(db);
      return m;
    },
    async updateMotor(id, data) {
      const db = loadLocal();
      const m = db.motors.find((x) => x.id === id);
      if (!m) throw new Error("Motor tidak ditemukan");
      Object.assign(m, validateMotor(data, true));
      saveLocal(db);
      return m;
    },
    async deleteMotor(id) {
      const db = loadLocal();
      db.motors = db.motors.filter((x) => x.id !== id);
      db.services = db.services.filter((s) => s.motor_id !== id);
      saveLocal(db);
      return { deleted: id };
    },
    async listServices(motorId) {
      return loadLocal().services
        .filter((s) => s.motor_id === motorId)
        .sort((a, b) => (b.tanggal > a.tanggal ? 1 : b.tanggal < a.tanggal ? -1 : b.km - a.km || b.id - a.id));
    },
    async createService(data) {
      const db = loadLocal();
      const m = db.motors.find((x) => x.id === Number(data.motor_id));
      if (!m) throw new Error("Motor tidak ditemukan");
      if (!data.tanggal) throw new Error("'tanggal' wajib diisi");
      if (data.km === "" || data.km == null) throw new Error("'km' wajib diisi");
      if (!data.jenis) throw new Error("'jenis' wajib diisi");
      const def = SERVICE_TYPES_DEFAULT.find((t) => t.jenis === data.jenis);
      const num = (v, d = 0) => (v === "" || v == null ? d : parseInt(v, 10));
      const s = {
        id: db.nextId++, motor_id: m.id, tanggal: data.tanggal, km: num(data.km), jenis: data.jenis,
        biaya: num(data.biaya), bengkel: data.bengkel || "", catatan: data.catatan || "",
        interval_km: num(data.interval_km, def ? def.interval_km : 0),
        interval_hari: num(data.interval_hari, def ? def.interval_hari : 0),
        created_at: nowIso(),
      };
      if ([s.km, s.biaya, s.interval_km, s.interval_hari].some((v) => isNaN(v) || v < 0))
        throw new Error("Angka tidak valid");
      db.services.push(s);
      if (s.km > m.km_sekarang) m.km_sekarang = s.km;
      saveLocal(db);
      return s;
    },
    async deleteService(id) {
      const db = loadLocal();
      db.services = db.services.filter((s) => s.id !== id);
      saveLocal(db);
      return { deleted: id };
    },
    async reminders() { return computeReminders(loadLocal()); },
  };

  // Pilih store: coba backend dulu.
  let store = LocalStore;
  async function detectBackend() {
    const badge = $("#mode-badge");
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(API_BASE + "/api/health", { signal: ctrl.signal });
      clearTimeout(t);
      const data = await res.json();
      if (data.status !== "ok") throw new Error("bad");
      store = RemoteStore;
      badge.textContent = "● Terhubung ke server";
      badge.className = "mode-badge online";
      badge.title = "Data disimpan di database server (SQLite)";
    } catch (_) {
      store = LocalStore;
      badge.textContent = "● Mode lokal";
      badge.className = "mode-badge offline";
      badge.title = "Server tidak terhubung — data disimpan di browser ini saja";
    }
  }

  // ------------------------------------------------------------------ //
  // State & navigasi
  // ------------------------------------------------------------------ //
  const state = { view: "dashboard", motorId: null, serviceTypes: SERVICE_TYPES_DEFAULT };

  function show(view) {
    state.view = view;
    for (const v of ["dashboard", "motors", "detail"]) $("#view-" + v).classList.toggle("hidden", v !== view);
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.view === view || (view === "detail" && t.dataset.view === "motors")));
    render();
  }

  async function render() {
    try {
      if (state.view === "dashboard") await renderDashboard();
      else if (state.view === "motors") await renderMotors();
      else await renderDetail();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ------------------------------------------------------------------ //
  // Render: dashboard
  // ------------------------------------------------------------------ //
  function dueText(r) {
    const parts = [];
    if (r.sisa_km != null)
      parts.push(r.sisa_km > 0 ? `<b>${fmtNum(r.sisa_km)} km</b> lagi` : `lewat <b>${fmtNum(-r.sisa_km)} km</b>`);
    if (r.sisa_hari != null)
      parts.push(r.sisa_hari > 0 ? `<b>${r.sisa_hari} hari</b> lagi` : r.sisa_hari === 0 ? "<b>hari ini</b>" : `lewat <b>${-r.sisa_hari} hari</b>`);
    return parts.join(" · ");
  }
  function progressPct(r) {
    // Berapa persen interval yang sudah terpakai (ambil yang paling mendesak).
    const pcts = [];
    if (r.jatuh_tempo_km != null) {
      const total = r.jatuh_tempo_km - r.servis_terakhir_km;
      if (total > 0) pcts.push((r.km_sekarang - r.servis_terakhir_km) / total);
    }
    if (r.jatuh_tempo_tanggal) {
      const a = new Date(r.servis_terakhir_tanggal), b = new Date(r.jatuh_tempo_tanggal), n = new Date(todayIso());
      if (b - a > 0) pcts.push((n - a) / (b - a));
    }
    const p = pcts.length ? Math.max(...pcts) : 0;
    return Math.min(100, Math.max(3, Math.round(p * 100)));
  }
  const statusLabel = { ok: "Aman", segera: "Segera", terlambat: "Terlambat" };

  function reminderCard(r, showMotor = true) {
    return `
      <div class="card reminder ${r.status} ${showMotor ? "clickable" : ""}" data-motor="${r.motor_id}">
        <div>
          <div class="title">${esc(r.jenis)}</div>
          <div class="meta">
            ${showMotor ? `${esc(r.motor_nama)} ${r.motor_plat ? `<span class="plat">${esc(r.motor_plat)}</span>` : ""} · ` : ""}
            terakhir ${fmtDate(r.servis_terakhir_tanggal)} di ${fmtNum(r.servis_terakhir_km)} km
          </div>
          <div class="due">${dueText(r)}
            ${r.jatuh_tempo_km != null ? ` · jatuh tempo ${fmtNum(r.jatuh_tempo_km)} km` : ""}
            ${r.jatuh_tempo_tanggal ? ` / ${fmtDate(r.jatuh_tempo_tanggal)}` : ""}
          </div>
        </div>
        <span class="pill ${r.status}">${statusLabel[r.status]}</span>
        <div class="progress"><span style="width:${progressPct(r)}%"></span></div>
      </div>`;
  }

  async function renderDashboard() {
    const [motors, rem] = await Promise.all([store.listMotors(), store.reminders()]);
    const late = rem.filter((r) => r.status === "terlambat").length;
    const soon = rem.filter((r) => r.status === "segera").length;
    const cost = motors.reduce((t, m) => t + (m.total_biaya || 0), 0);
    $("#stats").innerHTML = `
      <div class="stat"><div class="label">Motor</div><div class="value">${motors.length}</div></div>
      <div class="stat ${late ? "bad" : ""}"><div class="label">Terlambat</div><div class="value">${late}</div></div>
      <div class="stat ${soon ? "warn" : ""}"><div class="label">Segera</div><div class="value">${soon}</div></div>
      <div class="stat"><div class="label">Total biaya servis</div><div class="value" style="font-size:18px">${fmtRp(cost)}</div></div>`;

    const list = $("#reminder-list");
    if (!motors.length) {
      list.innerHTML = `<div class="empty">Belum ada motor. Tambahkan motor dulu, lalu catat servis terakhirnya.
        <div><button class="btn primary" data-action="add-motor">+ Tambah motor</button></div></div>`;
    } else if (!rem.length) {
      list.innerHTML = `<div class="empty">Belum ada catatan servis. Buka motor Anda dan catat servis terakhir agar jadwal berikutnya bisa dihitung.</div>`;
    } else {
      list.innerHTML = rem.map((r) => reminderCard(r)).join("");
    }
  }

  // ------------------------------------------------------------------ //
  // Render: daftar motor
  // ------------------------------------------------------------------ //
  async function renderMotors() {
    const motors = await store.listMotors();
    const el = $("#motor-list");
    if (!motors.length) {
      el.innerHTML = `<div class="empty" style="grid-column:1/-1">Belum ada motor terdaftar.
        <div><button class="btn primary" data-action="add-motor">+ Tambah motor</button></div></div>`;
      return;
    }
    el.innerHTML = motors.map((m) => `
      <div class="card clickable" data-motor="${m.id}">
        <div class="row">
          <div class="title">${esc(m.nama)}</div>
          ${m.plat ? `<span class="plat">${esc(m.plat)}</span>` : ""}
        </div>
        <div class="meta">${esc([m.merk, m.tahun].filter(Boolean).join(" · ")) || "&nbsp;"}</div>
        <div class="row" style="margin-top:10px">
          <div><div class="meta">Odometer</div><b>${fmtNum(m.km_sekarang)} km</b></div>
          <div style="text-align:right"><div class="meta">${m.jumlah_servis} servis</div><b>${fmtRp(m.total_biaya)}</b></div>
        </div>
      </div>`).join("");
  }

  // ------------------------------------------------------------------ //
  // Render: detail motor
  // ------------------------------------------------------------------ //
  async function renderDetail() {
    const id = state.motorId;
    const [m, services, rem] = await Promise.all([store.getMotor(id), store.listServices(id), store.reminders()]);
    const myRem = rem.filter((r) => r.motor_id === id);
    $("#motor-detail").innerHTML = `
      <div class="card">
        <div class="detail-head">
          <div>
            <h2>${esc(m.nama)}</h2>
            <div class="meta" style="margin-top:4px">
              ${m.plat ? `<span class="plat">${esc(m.plat)}</span> ` : ""}${esc([m.merk, m.tahun].filter(Boolean).join(" · "))}
            </div>
          </div>
          <div style="text-align:right">
            <div class="meta">Odometer sekarang</div>
            <div class="km-big">${fmtNum(m.km_sekarang)} km</div>
          </div>
        </div>
        <div class="actions">
          <button class="btn primary" data-action="update-km">Update kilometer</button>
          <button class="btn" data-action="edit-motor">Edit motor</button>
          <button class="btn danger" data-action="delete-motor">Hapus</button>
        </div>
      </div>
      ${myRem.length ? `<div class="section-head"><h2>Pengingat</h2></div><div class="list">${myRem.map((r) => reminderCard(r, false)).join("")}</div>` : ""}`;

    $("#service-list").innerHTML = services.length
      ? services.map((s) => `
        <div class="card">
          <div class="row">
            <div>
              <div class="title">${esc(s.jenis)}</div>
              <div class="meta">${fmtDate(s.tanggal)} · ${fmtNum(s.km)} km${s.bengkel ? " · " + esc(s.bengkel) : ""}</div>
              ${s.catatan ? `<div class="meta" style="margin-top:4px">${esc(s.catatan)}</div>` : ""}
            </div>
            <div style="text-align:right">
              <b>${fmtRp(s.biaya)}</b>
              <div><button class="btn ghost small danger" data-action="delete-service" data-id="${s.id}">Hapus</button></div>
            </div>
          </div>
        </div>`).join("")
      : `<div class="empty">Belum ada riwayat servis untuk motor ini.</div>`;
  }

  // ------------------------------------------------------------------ //
  // Modal & form
  // ------------------------------------------------------------------ //
  function openModal(title, html, onSubmit) {
    $("#modal-title").textContent = title;
    const form = $("#modal-form");
    form.innerHTML = html + `
      <div class="form-actions">
        <button type="button" class="btn" data-action="close-modal">Batal</button>
        <button type="submit" class="btn primary">Simpan</button>
      </div>`;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        await onSubmit(data);
        closeModal();
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
    $("#modal").classList.remove("hidden");
    setTimeout(() => form.querySelector("input,select")?.focus(), 30);
  }
  function closeModal() { $("#modal").classList.add("hidden"); }

  function motorForm(m = {}) {
    return `
      <label>Nama motor *<input name="nama" required placeholder="mis. Vario 160" value="${esc(m.nama)}"></label>
      <div class="form-row">
        <label>Plat nomor<input name="plat" placeholder="L 1234 AB" value="${esc(m.plat)}"></label>
        <label>Merk<input name="merk" placeholder="Honda" value="${esc(m.merk)}"></label>
      </div>
      <div class="form-row">
        <label>Tahun<input name="tahun" type="number" min="1950" max="2100" value="${esc(m.tahun)}"></label>
        <label>Odometer (km)<input name="km_sekarang" type="number" min="0" required value="${esc(m.km_sekarang ?? 0)}"></label>
      </div>`;
  }

  function addMotor() {
    openModal("Tambah motor", motorForm(), async (d) => {
      const m = await store.createMotor(d);
      toast("Motor ditambahkan");
      state.motorId = m.id;
      state.view = "detail";
      show("detail");
    });
  }

  async function addService() {
    const m = await store.getMotor(state.motorId);
    const types = state.serviceTypes;
    openModal("Catat servis", `
      <label>Jenis servis *
        <select name="jenis" id="f-jenis" required>
          ${types.map((t) => `<option value="${esc(t.jenis)}">${esc(t.jenis)}</option>`).join("")}
        </select>
      </label>
      <div class="form-row">
        <label>Tanggal *<input name="tanggal" type="date" required value="${todayIso()}"></label>
        <label>Kilometer saat servis *<input name="km" type="number" min="0" required value="${m.km_sekarang}"></label>
      </div>
      <div class="form-row">
        <label>Biaya (Rp)<input name="biaya" type="number" min="0" step="500" placeholder="0"></label>
        <label>Bengkel<input name="bengkel" placeholder="AHASS, bengkel langganan…"></label>
      </div>
      <div class="form-row">
        <label>Ingatkan lagi tiap (km)<input name="interval_km" id="f-ikm" type="number" min="0"></label>
        <label>atau tiap (hari)<input name="interval_hari" id="f-ihari" type="number" min="0"></label>
      </div>
      <span class="hint meta">Isi 0 di keduanya jika servis ini tidak perlu diingatkan. Yang lebih dulu tercapai yang dipakai.</span>
      <label>Catatan<textarea name="catatan" rows="2" placeholder="Oli merk apa, part yang diganti…"></textarea></label>
    `, async (d) => {
      await store.createService({ ...d, motor_id: state.motorId });
      toast("Servis dicatat");
    });
    const sel = $("#f-jenis");
    const fill = () => {
      const t = types.find((x) => x.jenis === sel.value);
      $("#f-ikm").value = t ? t.interval_km : 0;
      $("#f-ihari").value = t ? t.interval_hari : 0;
    };
    sel.addEventListener("change", fill);
    fill();
  }

  async function updateKm() {
    const m = await store.getMotor(state.motorId);
    openModal("Update kilometer", `
      <label>Odometer sekarang (km)
        <input name="km_sekarang" type="number" min="0" required value="${m.km_sekarang}">
      </label>
      <span class="hint meta">Lihat angka di speedometer. Pengingat dihitung ulang otomatis.</span>`,
      async (d) => {
        if (Number(d.km_sekarang) < m.km_sekarang && !(await askConfirm("Kilometer baru lebih kecil dari sebelumnya. Lanjutkan?"))) return;
        await store.updateMotor(state.motorId, { km_sekarang: d.km_sekarang });
        toast("Kilometer diperbarui");
      });
  }

  async function editMotor() {
    const m = await store.getMotor(state.motorId);
    openModal("Edit motor", motorForm(m), async (d) => {
      await store.updateMotor(state.motorId, d);
      toast("Data motor disimpan");
    });
  }

  async function deleteMotor() {
    if (!(await askConfirm("Hapus motor ini beserta semua riwayat servisnya?"))) return;
    await store.deleteMotor(state.motorId);
    toast("Motor dihapus");
    show("motors");
  }

  async function deleteService(id) {
    if (!(await askConfirm("Hapus catatan servis ini?"))) return;
    await store.deleteService(id);
    toast("Catatan servis dihapus");
    render();
  }

  // ------------------------------------------------------------------ //
  // Event
  // ------------------------------------------------------------------ //
  document.addEventListener("click", async (e) => {
    const tab = e.target.closest(".tab");
    if (tab) return show(tab.dataset.view);

    const act = e.target.closest("[data-action]");
    if (act) {
      e.stopPropagation();
      const a = act.dataset.action;
      try {
        if (a === "add-motor") return addMotor();
        if (a === "close-modal") return closeModal();
        if (a === "update-km") return await updateKm();
        if (a === "edit-motor") return await editMotor();
        if (a === "delete-motor") return await deleteMotor();
        if (a === "delete-service") return await deleteService(Number(act.dataset.id));
      } catch (err) { toast(err.message, true); }
      return;
    }

    const card = e.target.closest("[data-motor].clickable");
    if (card) {
      state.motorId = Number(card.dataset.motor);
      show("detail");
    }
  });

  $("#btn-add-motor").addEventListener("click", addMotor);
  $("#btn-add-service").addEventListener("click", () => addService().catch((err) => toast(err.message, true)));
  $("#btn-back").addEventListener("click", () => show("motors"));
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#confirm").classList.contains("hidden")) $("#confirm-no").click();
    else closeModal();
  });

  (async function init() {
    await detectBackend();
    try { state.serviceTypes = await store.serviceTypes(); } catch (_) { /* pakai default */ }
    show("dashboard");
  })();
})();
