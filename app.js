/* Giao diện mượn sách thư viện – JavaScript thuần, không phụ thuộc thư viện ngoài. */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const appEl = $("#app");
  const state = { user: null, loanDays: 14, maxLoans: 5, pendingCount: 0 };

  const STATUS_LABEL = {
    pending: "Chờ duyệt", borrowing: "Đang mượn", returned: "Đã trả",
    rejected: "Bị từ chối", cancelled: "Đã hủy", overdue: "Quá hạn",
  };

  // ---------- tiện ích ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtDate(s) {
    if (!s) return "—";
    const d = s.slice(0, 10).split("-");
    return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : s;
  }
  function badge(loan) {
    if (loan.overdue) return `<span class="badge overdue">Quá hạn</span>`;
    return `<span class="badge ${esc(loan.status)}">${STATUS_LABEL[loan.status] || esc(loan.status)}</span>`;
  }
  let toastTimer;
  function toast(msg, isError) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast"), 3200);
  }
  async function api(path, opts = {}) {
    const o = { method: opts.method || "GET", headers: {}, credentials: "same-origin" };
    if (opts.json !== undefined) {
      o.headers["Content-Type"] = "application/json";
      o.body = JSON.stringify(opts.json);
    }
    if (opts.form) o.body = opts.form;
    let res;
    try { res = await fetch(path, o); }
    catch (e) { throw new Error("Không kết nối được máy chủ. Vui lòng thử lại."); }
    let data = {};
    try { data = await res.json(); } catch (e) { /* trống */ }
    if (!res.ok) {
      const err = new Error(data.error || "Có lỗi xảy ra, vui lòng thử lại.");
      err.status = res.status;
      throw err;
    }
    return data;
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  // ---------- hộp thoại ----------
  function openModal(html, onReady) {
    closeModal();
    const root = $("#modalRoot");
    root.innerHTML = `<div class="overlay" id="overlay"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const overlay = $("#overlay");
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", escClose);
    const first = root.querySelector("input,select,textarea,button");
    if (first) first.focus();
    if (onReady) onReady(root);
  }
  function escClose(e) { if (e.key === "Escape") closeModal(); }
  function closeModal() {
    $("#modalRoot").innerHTML = "";
    document.removeEventListener("keydown", escClose);
  }

  // ---------- thanh điều hướng ----------
  function renderNav(active) {
    const top = $("#topnav"), sub = $("#subnav");
    const u = state.user;
    const link = (href, text, key) => `<a href="${href}" class="${active === key ? "active" : ""}">${text}</a>`;
    let t = link("#/", "Trang chủ", "home");
    if (!u) {
      t += link("#/login", "Đăng nhập", "login") + link("#/register", "Đăng ký bạn đọc", "register");
    } else {
      t += `<span class="who">${u.role === "admin" ? "Thủ thư · " : ""}${esc(u.full_name)}</span>` +
        `<button class="linklike" id="logoutBtn">Đăng xuất</button>`;
    }
    top.innerHTML = t;
    const lb = $("#logoutBtn");
    if (lb) lb.onclick = async () => {
      await api("/api/logout", { method: "POST" });
      state.user = null; toast("Đã đăng xuất.");
      go("#/");
    };

    let s = link("#/", "Danh mục sách", "home");
    if (u && u.role === "reader") {
      s += link("#/my", "Sách của tôi", "my") + link("#/account", "Tài khoản", "account");
    } else if (u && u.role === "admin") {
      s = link("#/admin", "Tổng quan", "admin") +
        link("#/admin/requests", `Yêu cầu mượn${state.pendingCount ? `<span class="badge alert">${state.pendingCount}</span>` : ""}`, "requests") +
        link("#/admin/borrowing", "Đang mượn / quá hạn", "borrowing") +
        link("#/admin/books", "Quản lý sách", "books") +
        link("#/admin/users", "Bạn đọc", "users") +
        link("#/", "Xem danh mục", "home") + link("#/account", "Tài khoản", "account");
    }
    sub.innerHTML = s;
    $("#topnav").classList.remove("open");
    $("#menuToggle").setAttribute("aria-expanded", "false");
  }
  $("#menuToggle").addEventListener("click", () => {
    const nav = $("#topnav");
    const open = nav.classList.toggle("open");
    $("#menuToggle").setAttribute("aria-expanded", String(open));
  });

  // ---------- trang: danh mục sách ----------
  const catalog = { q: "", category: "", available: false, page: 1 };

  async function viewHome() {
    renderNav("home");
    const cats = await api("/api/categories").catch(() => []);
    appEl.innerHTML = `
      <section class="hero">
        <h1>Tra cứu &amp; đăng ký mượn sách</h1>
        <p>Tìm sách trong kho của thư viện, đăng ký mượn trực tuyến và đến quầy nhận sách khi thủ thư duyệt yêu cầu.</p>
        <form class="searchbar" id="searchForm" role="search">
          <input type="search" id="q" placeholder="Nhập tên sách, tác giả, ISBN…" aria-label="Từ khóa tìm kiếm" value="${esc(catalog.q)}">
          <select id="cat" aria-label="Thể loại">
            <option value="">Tất cả thể loại</option>
            ${cats.map((c) => `<option ${c === catalog.category ? "selected" : ""} value="${esc(c)}">${esc(c)}</option>`).join("")}
          </select>
          <button class="btn" type="submit">Tìm kiếm</button>
        </form>
      </section>
      ${state.user ? "" : `<div class="alert-box info">Bạn cần <a href="#/login">đăng nhập</a> hoặc <a href="#/register">đăng ký tài khoản bạn đọc</a> để đăng ký mượn sách.</div>`}
      <div class="filters">
        <label class="check"><input type="checkbox" id="onlyAvail" ${catalog.available ? "checked" : ""}> Chỉ hiện sách còn trong thư viện</label>
        <span class="muted small" id="resultCount"></span>
      </div>
      <div id="bookList" class="books" aria-live="polite"></div>
      <div id="pager" class="pager"></div>`;
    $("#searchForm").onsubmit = (e) => {
      e.preventDefault();
      catalog.q = $("#q").value.trim(); catalog.category = $("#cat").value; catalog.page = 1;
      loadBooks();
    };
    $("#cat").onchange = () => $("#searchForm").requestSubmit();
    $("#onlyAvail").onchange = (e) => { catalog.available = e.target.checked; catalog.page = 1; loadBooks(); };
    loadBooks();
  }

  async function loadBooks() {
    const list = $("#bookList");
    if (!list) return;
    const per = 12;
    const params = new URLSearchParams({ q: catalog.q, category: catalog.category, page: catalog.page, per });
    if (catalog.available) params.set("available", "1");
    try {
      const data = await api("/api/books?" + params);
      $("#resultCount").textContent = `${data.total} đầu sách`;
      if (!data.items.length) {
        list.innerHTML = `<div class="empty card" style="grid-column:1/-1">Không tìm thấy sách phù hợp.</div>`;
      } else {
        list.innerHTML = data.items.map(bookCard).join("");
      }
      const pages = Math.max(Math.ceil(data.total / per), 1);
      $("#pager").innerHTML = pages > 1 ? `
        <button class="btn ghost sm" id="prevP" ${catalog.page <= 1 ? "disabled" : ""}>‹ Trước</button>
        <span class="muted small">Trang ${catalog.page} / ${pages}</span>
        <button class="btn ghost sm" id="nextP" ${catalog.page >= pages ? "disabled" : ""}>Sau ›</button>` : "";
      const pv = $("#prevP"), nx = $("#nextP");
      if (pv) pv.onclick = () => { catalog.page--; loadBooks(); window.scrollTo({ top: 0, behavior: "smooth" }); };
      if (nx) nx.onclick = () => { catalog.page++; loadBooks(); window.scrollTo({ top: 0, behavior: "smooth" }); };
      list.querySelectorAll("[data-borrow]").forEach((b) => (b.onclick = () => borrowBook(Number(b.dataset.borrow), b.dataset.title)));
      list.querySelectorAll("[data-detail]").forEach((b) => (b.onclick = () => showBook(Number(b.dataset.detail))));
    } catch (e) { list.innerHTML = `<div class="alert-box error" style="grid-column:1/-1">${esc(e.message)}</div>`; }
  }

  function availBadge(b) {
    return b.available > 0
      ? `<span class="badge ok">Còn ${b.available}/${b.copies} bản</span>`
      : `<span class="badge alert">Đã mượn hết</span>`;
  }
  function bookCard(b) {
    const canBorrow = state.user && state.user.role === "reader" && b.available > 0;
    return `<article class="card book">
      <div class="cover"></div>
      <h3>${esc(b.title)}</h3>
      <div class="meta">${esc(b.author || "Chưa rõ tác giả")}${b.year ? " · " + esc(b.year) : ""}</div>
      <div class="meta">${b.category ? esc(b.category) : ""}${b.location ? " · Vị trí: " + esc(b.location) : ""}</div>
      <div class="foot">
        ${availBadge(b)}
        <span style="display:flex;gap:6px">
          <button class="btn ghost sm" data-detail="${b.id}">Chi tiết</button>
          ${canBorrow ? `<button class="btn sm" data-borrow="${b.id}" data-title="${esc(b.title)}">Đăng ký mượn</button>` : ""}
        </span>
      </div>
    </article>`;
  }

  async function showBook(id) {
    try {
      const b = await api("/api/books/" + id);
      const canBorrow = state.user && state.user.role === "reader" && b.available > 0;
      openModal(`
        <h2>${esc(b.title)}</h2>
        <table><tbody>
          <tr><th>Tác giả</th><td>${esc(b.author) || "—"}</td></tr>
          <tr><th>Thể loại</th><td>${esc(b.category) || "—"}</td></tr>
          <tr><th>Nhà xuất bản</th><td>${esc(b.publisher) || "—"}${b.year ? ", " + esc(b.year) : ""}</td></tr>
          <tr><th>ISBN</th><td>${esc(b.isbn) || "—"}</td></tr>
          <tr><th>Vị trí trên kệ</th><td>${esc(b.location) || "—"}</td></tr>
          <tr><th>Tình trạng</th><td>${availBadge(b)}</td></tr>
        </tbody></table>
        ${b.description ? `<p>${esc(b.description)}</p>` : ""}
        <div class="btns">
          <button class="btn ghost" id="mClose">Đóng</button>
          ${canBorrow ? `<button class="btn" id="mBorrow">Đăng ký mượn</button>` : ""}
        </div>`, () => {
        $("#mClose").onclick = closeModal;
        const mb = $("#mBorrow");
        if (mb) mb.onclick = () => { closeModal(); borrowBook(b.id, b.title); };
      });
    } catch (e) { toast(e.message, true); }
  }

  function borrowBook(id, title) {
    if (!state.user) { toast("Vui lòng đăng nhập để mượn sách.", true); go("#/login"); return; }
    openModal(`
      <h2>Đăng ký mượn sách</h2>
      <p>Bạn muốn đăng ký mượn cuốn <strong>${esc(title)}</strong>?</p>
      <p class="muted small">Thủ thư sẽ duyệt yêu cầu. Sau khi được duyệt, bạn đến quầy thư viện để nhận sách; thời hạn mượn mặc định là ${state.loanDays} ngày kể từ ngày duyệt.</p>
      <div class="field"><label for="note">Ghi chú cho thủ thư (không bắt buộc)</label><input id="note" maxlength="300" placeholder="Ví dụ: tôi sẽ đến nhận vào chiều thứ Sáu"></div>
      <div class="btns"><button class="btn ghost" id="mNo">Để sau</button><button class="btn" id="mYes">Gửi yêu cầu</button></div>`, () => {
      $("#mNo").onclick = closeModal;
      $("#mYes").onclick = async () => {
        $("#mYes").disabled = true;
        try {
          await api("/api/loans", { method: "POST", json: { book_id: id, note: $("#note").value } });
          closeModal(); toast("Đã gửi yêu cầu mượn sách. Vui lòng chờ thủ thư duyệt.");
          if (location.hash.startsWith("#/my")) route(); else loadBooks();
        } catch (e) { closeModal(); toast(e.message, true); }
      };
    });
  }

  // ---------- đăng nhập / đăng ký ----------
  function viewLogin() {
    renderNav("login");
    appEl.innerHTML = `<div class="card auth">
      <h1>Đăng nhập</h1>
      <div id="msg"></div>
      <form id="f">
        <div class="field"><label for="u">Tên đăng nhập</label><input id="u" autocomplete="username" required></div>
        <div class="field"><label for="p">Mật khẩu</label><input id="p" type="password" autocomplete="current-password" required></div>
        <button class="btn" style="width:100%">Đăng nhập</button>
      </form>
      <p class="muted small" style="margin-bottom:0">Chưa có tài khoản? <a href="#/register">Đăng ký bạn đọc</a>. Thủ thư đăng nhập bằng tài khoản được cấp riêng.</p>
    </div>`;
    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const u = await api("/api/login", { method: "POST", json: { username: $("#u").value, password: $("#p").value } });
        state.user = u; toast("Đăng nhập thành công.");
        go(u.role === "admin" ? "#/admin" : "#/");
      } catch (er) { $("#msg").innerHTML = `<div class="alert-box error">${esc(er.message)}</div>`; }
    };
  }

  function viewRegister() {
    renderNav("register");
    appEl.innerHTML = `<div class="card auth">
      <h1>Đăng ký bạn đọc</h1>
      <div id="msg"></div>
      <form id="f">
        <div class="field"><label for="fn">Họ và tên</label><input id="fn" autocomplete="name" required maxlength="100"></div>
        <div class="grid2">
          <div class="field"><label for="sid">Mã sinh viên / mã thẻ</label><input id="sid" maxlength="30"></div>
          <div class="field"><label for="em">Email</label><input id="em" type="email" autocomplete="email" maxlength="120"></div>
        </div>
        <div class="field"><label for="u">Tên đăng nhập</label><input id="u" autocomplete="username" required minlength="3" maxlength="40">
          <div class="hint">3–40 ký tự, chữ không dấu, số hoặc . _ -</div></div>
        <div class="field"><label for="p">Mật khẩu</label><input id="p" type="password" autocomplete="new-password" required minlength="6">
          <div class="hint">Ít nhất 6 ký tự.</div></div>
        <button class="btn" style="width:100%">Tạo tài khoản</button>
      </form>
      <p class="muted small" style="margin-bottom:0">Đã có tài khoản? <a href="#/login">Đăng nhập</a></p>
    </div>`;
    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      try {
        state.user = await api("/api/register", { method: "POST", json: {
          full_name: $("#fn").value, student_id: $("#sid").value, email: $("#em").value,
          username: $("#u").value, password: $("#p").value } });
        toast("Đăng ký thành công. Chào mừng bạn!");
        go("#/");
      } catch (er) { $("#msg").innerHTML = `<div class="alert-box error">${esc(er.message)}</div>`; }
    };
  }

  function viewAccount() {
    if (!state.user) return go("#/login");
    renderNav("account");
    const u = state.user;
    appEl.innerHTML = `<div class="page-head"><h1>Tài khoản</h1></div>
      <div class="card" style="max-width:520px">
        <table><tbody>
          <tr><th>Họ và tên</th><td>${esc(u.full_name)}</td></tr>
          <tr><th>Tên đăng nhập</th><td>${esc(u.username)}</td></tr>
          ${u.role === "reader" ? `<tr><th>Mã SV / thẻ</th><td>${esc(u.student_id) || "—"}</td></tr><tr><th>Email</th><td>${esc(u.email) || "—"}</td></tr>` : ""}
          <tr><th>Vai trò</th><td>${u.role === "admin" ? "Thủ thư (quản trị)" : "Bạn đọc"}</td></tr>
        </tbody></table>
        <h2 style="margin-top:20px">Đổi mật khẩu</h2>
        <div id="msg"></div>
        <form id="f">
          <div class="field"><label for="op">Mật khẩu hiện tại</label><input id="op" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="np">Mật khẩu mới</label><input id="np" type="password" autocomplete="new-password" minlength="6" required></div>
          <button class="btn">Cập nhật mật khẩu</button>
        </form>
      </div>`;
    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/api/me/password", { method: "POST", json: { old_password: $("#op").value, new_password: $("#np").value } });
        $("#f").reset(); $("#msg").innerHTML = `<div class="alert-box success">Đã đổi mật khẩu.</div>`;
      } catch (er) { $("#msg").innerHTML = `<div class="alert-box error">${esc(er.message)}</div>`; }
    };
  }

  // ---------- bạn đọc: sách của tôi ----------
  async function viewMy() {
    if (!state.user) return go("#/login");
    if (state.user.role !== "reader") return go("#/admin");
    renderNav("my");
    appEl.innerHTML = `<div class="page-head"><h1>Sách của tôi</h1></div><div id="box" class="card"><p class="muted">Đang tải…</p></div>`;
    try {
      const loans = await api("/api/loans/mine");
      const active = loans.filter((l) => l.status === "pending" || l.status === "borrowing");
      const overdue = loans.filter((l) => l.overdue).length;
      $("#box").innerHTML = `
        ${overdue ? `<div class="alert-box error">Bạn có ${overdue} cuốn quá hạn. Vui lòng mang sách đến trả cho thủ thư.</div>` : ""}
        <p class="muted small">Đang đăng ký/mượn: <strong>${active.length}/${state.maxLoans}</strong> cuốn.</p>
        ${loans.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Sách</th><th>Ngày đăng ký</th><th>Hạn trả</th><th>Trạng thái</th><th></th></tr></thead>
          <tbody>${loans.map((l) => `<tr>
            <td><strong>${esc(l.book_title)}</strong><div class="muted small">${esc(l.book_author)}${l.book_location ? " · Vị trí: " + esc(l.book_location) : ""}</div>
              ${l.status === "rejected" && l.note ? `<div class="small" style="color:var(--red)">Lý do từ chối: ${esc(l.note)}</div>` : ""}</td>
            <td>${fmtDate(l.requested_at)}</td>
            <td>${l.status === "borrowing" ? fmtDate(l.due_date) : l.status === "returned" ? "Đã trả " + fmtDate(l.returned_at) : "—"}</td>
            <td>${badge(l)}</td>
            <td>${l.status === "pending" ? `<button class="btn ghost sm" data-cancel="${l.id}">Hủy yêu cầu</button>` : ""}</td>
          </tr>`).join("")}</tbody></table></div>`
          : `<div class="empty">Bạn chưa đăng ký mượn cuốn nào. <a href="#/">Xem danh mục sách</a></div>`}`;
      document.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
        if (!confirm("Hủy yêu cầu mượn sách này?")) return;
        try { await api(`/api/loans/${b.dataset.cancel}/cancel`, { method: "POST" }); toast("Đã hủy yêu cầu."); viewMy(); }
        catch (e) { toast(e.message, true); }
      }));
    } catch (e) { $("#box").innerHTML = `<div class="alert-box error">${esc(e.message)}</div>`; }
  }

  // ---------- thủ thư ----------
  async function refreshPending() {
    try { state.pendingCount = (await api("/api/admin/stats")).pending; } catch (e) { /* bỏ qua */ }
  }
  function needAdmin() {
    if (!state.user) { go("#/login"); return false; }
    if (state.user.role !== "admin") { toast("Bạn không có quyền truy cập khu vực này.", true); go("#/"); return false; }
    return true;
  }

  async function viewAdminHome() {
    if (!needAdmin()) return;
    await refreshPending(); renderNav("admin");
    appEl.innerHTML = `<div class="page-head"><h1>Tổng quan</h1></div><div id="box"><p class="muted">Đang tải…</p></div>`;
    try {
      const s = await api("/api/admin/stats");
      const tile = (n, l, href, warn) => `<a class="card stat" style="text-decoration:none;color:inherit" href="${href}">
        <div class="num" ${warn && n ? 'style="color:var(--red)"' : ""}>${n}</div><div class="lbl">${l}</div></a>`;
      $("#box").innerHTML = `
        <div class="stats">
          ${tile(s.pending, "Yêu cầu chờ duyệt", "#/admin/requests", true)}
          ${tile(s.borrowing, "Sách đang cho mượn", "#/admin/borrowing")}
          ${tile(s.overdue, "Phiếu quá hạn", "#/admin/borrowing", true)}
          ${tile(s.titles, `Đầu sách (${s.copies} bản)`, "#/admin/books")}
          ${tile(s.readers, "Bạn đọc", "#/admin/users")}
        </div>
        <div class="card"><h2>Sách được mượn nhiều nhất</h2>
          ${s.top_books.length ? `<table><tbody>${s.top_books.map((b, i) => `<tr><td style="width:36px">${i + 1}</td><td>${esc(b.title)}</td><td style="text-align:right">${b.count} lượt</td></tr>`).join("")}</tbody></table>`
            : `<p class="muted">Chưa có dữ liệu mượn sách.</p>`}</div>`;
    } catch (e) { $("#box").innerHTML = `<div class="alert-box error">${esc(e.message)}</div>`; }
  }

  async function viewAdminLoans(mode) {
    if (!needAdmin()) return;
    await refreshPending(); renderNav(mode);
    const isReq = mode === "requests";
    const tabs = isReq ? [["pending", "Chờ duyệt"], ["rejected", "Đã từ chối"], ["cancelled", "Bạn đọc đã hủy"]]
      : [["borrowing", "Đang mượn"], ["overdue", "Quá hạn"], ["returned", "Đã trả"]];
    let cur = tabs[0][0], q = "";
    appEl.innerHTML = `<div class="page-head"><h1>${isReq ? "Yêu cầu mượn sách" : "Phiếu mượn"}</h1></div>
      <div class="tabs" id="tabs">${tabs.map(([k, v]) => `<button class="tab" data-k="${k}">${v}</button>`).join("")}</div>
      <div class="toolbar"><input type="search" id="q" placeholder="Tìm theo tên sách, tên/mã bạn đọc…" aria-label="Tìm kiếm"></div>
      <div class="card table-wrap" id="box"></div>`;
    async function load() {
      document.querySelectorAll("#tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.k === cur));
      const box = $("#box"); box.innerHTML = `<p class="muted">Đang tải…</p>`;
      try {
        const rows = await api(`/api/admin/loans?status=${cur}&q=${encodeURIComponent(q)}`);
        if (!rows.length) { box.innerHTML = `<div class="empty">Không có dữ liệu.</div>`; return; }
        box.innerHTML = `<table><thead><tr><th>Sách</th><th>Bạn đọc</th><th>Ngày đăng ký</th><th>${cur === "returned" ? "Ngày trả" : "Hạn trả"}</th><th>Trạng thái</th><th></th></tr></thead><tbody>
          ${rows.map((l) => `<tr>
            <td><strong>${esc(l.book_title)}</strong><div class="muted small">${esc(l.book_location) ? "Vị trí: " + esc(l.book_location) : ""}</div></td>
            <td>${esc(l.user_name)}<div class="muted small">${esc(l.user_username)}${l.user_student_id ? " · " + esc(l.user_student_id) : ""}</div></td>
            <td>${fmtDate(l.requested_at)}${l.note && l.status !== "rejected" ? `<div class="muted small">“${esc(l.note)}”</div>` : ""}</td>
            <td>${l.status === "returned" ? fmtDate(l.returned_at) : l.status === "borrowing" ? fmtDate(l.due_date) : "—"}</td>
            <td>${badge(l)}${l.status === "rejected" && l.note ? `<div class="muted small">${esc(l.note)}</div>` : ""}</td>
            <td><div class="actions">${loanActions(l)}</div></td></tr>`).join("")}
        </tbody></table>`;
        box.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => loanAction(b.dataset.act, Number(b.dataset.id), b.dataset.title, load)));
      } catch (e) { box.innerHTML = `<div class="alert-box error">${esc(e.message)}</div>`; }
    }
    document.querySelectorAll("#tabs .tab").forEach((t) => (t.onclick = () => { cur = t.dataset.k; load(); }));
    let timer;
    $("#q").oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { q = e.target.value.trim(); load(); }, 300); };
    load();
  }

  function loanActions(l) {
    const a = (act, text, cls) => `<button class="btn sm ${cls || ""}" data-act="${act}" data-id="${l.id}" data-title="${esc(l.book_title)}">${text}</button>`;
    if (l.status === "pending") return a("approve", "Duyệt & giao sách", "green") + a("reject", "Từ chối", "secondary");
    if (l.status === "borrowing") return a("return", "Nhận trả", "green") + a("extend", "Gia hạn", "ghost");
    return "";
  }

  function loanAction(act, id, title, reload) {
    const done = async (fn, msg) => {
      try { await fn(); closeModal(); toast(msg); await refreshPending(); renderNavKeep(); reload(); }
      catch (e) { closeModal(); toast(e.message, true); }
    };
    if (act === "approve") {
      openModal(`<h2>Duyệt &amp; giao sách</h2><p><strong>${esc(title)}</strong></p>
        <div class="field"><label for="days">Số ngày được mượn</label><input id="days" type="number" min="1" max="120" value="${state.loanDays}"></div>
        <div class="btns"><button class="btn ghost" id="mNo">Đóng</button><button class="btn green" id="mYes">Xác nhận giao sách</button></div>`, () => {
        $("#mNo").onclick = closeModal;
        $("#mYes").onclick = () => done(() => api(`/api/admin/loans/${id}/approve`, { method: "POST", json: { days: Number($("#days").value) } }), "Đã duyệt yêu cầu.");
      });
    } else if (act === "reject") {
      openModal(`<h2>Từ chối yêu cầu</h2><p><strong>${esc(title)}</strong></p>
        <div class="field"><label for="why">Lý do (bạn đọc sẽ nhìn thấy)</label><input id="why" maxlength="300" placeholder="Ví dụ: sách đang được giữ cho môn học"></div>
        <div class="btns"><button class="btn ghost" id="mNo">Đóng</button><button class="btn" id="mYes">Từ chối</button></div>`, () => {
        $("#mNo").onclick = closeModal;
        $("#mYes").onclick = () => done(() => api(`/api/admin/loans/${id}/reject`, { method: "POST", json: { note: $("#why").value } }), "Đã từ chối yêu cầu.");
      });
    } else if (act === "return") {
      openModal(`<h2>Nhận trả sách</h2><p>Xác nhận đã nhận lại <strong>${esc(title)}</strong>?</p>
        <div class="btns"><button class="btn ghost" id="mNo">Đóng</button><button class="btn green" id="mYes">Đã nhận sách</button></div>`, () => {
        $("#mNo").onclick = closeModal;
        $("#mYes").onclick = () => done(() => api(`/api/admin/loans/${id}/return`, { method: "POST" }), "Đã ghi nhận trả sách.");
      });
    } else if (act === "extend") {
      openModal(`<h2>Gia hạn</h2><p><strong>${esc(title)}</strong></p>
        <div class="field"><label for="days">Gia hạn thêm (ngày)</label><input id="days" type="number" min="1" max="60" value="7"></div>
        <div class="btns"><button class="btn ghost" id="mNo">Đóng</button><button class="btn" id="mYes">Gia hạn</button></div>`, () => {
        $("#mNo").onclick = closeModal;
        $("#mYes").onclick = () => done(() => api(`/api/admin/loans/${id}/extend`, { method: "POST", json: { days: Number($("#days").value) } }), "Đã gia hạn.");
      });
    }
  }
  function renderNavKeep() {
    const h = location.hash;
    renderNav(h.includes("requests") ? "requests" : h.includes("borrowing") ? "borrowing" : h.includes("books") ? "books" : h.includes("users") ? "users" : "admin");
  }

  // --- quản lý sách
  const adminBooks = { q: "", page: 1 };
  async function viewAdminBooks() {
    if (!needAdmin()) return;
    await refreshPending(); renderNav("books");
    appEl.innerHTML = `<div class="page-head"><h1>Quản lý sách</h1>
        <div class="toolbar" style="margin:0"><button class="btn" id="addBook">+ Thêm sách</button>
        <button class="btn secondary" id="impBook">Nhập từ CSV</button></div></div>
      <div class="toolbar"><input type="search" id="q" placeholder="Tìm theo tên, tác giả, ISBN…" value="${esc(adminBooks.q)}" aria-label="Tìm sách"></div>
      <div class="card table-wrap" id="box"></div><div class="pager" id="pager"></div>`;
    $("#addBook").onclick = () => bookForm(null);
    $("#impBook").onclick = importForm;
    let timer;
    $("#q").oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { adminBooks.q = e.target.value.trim(); adminBooks.page = 1; load(); }, 300); };
    async function load() {
      const per = 20;
      try {
        const d = await api(`/api/books?q=${encodeURIComponent(adminBooks.q)}&page=${adminBooks.page}&per=${per}`);
        const box = $("#box");
        if (!d.items.length) box.innerHTML = `<div class="empty">Chưa có sách nào. Hãy thêm sách hoặc nhập từ tệp CSV.</div>`;
        else box.innerHTML = `<table><thead><tr><th>Tên sách</th><th>Tác giả</th><th>Thể loại</th><th>Vị trí</th><th>Còn / Tổng</th><th></th></tr></thead><tbody>
          ${d.items.map((b) => `<tr><td><strong>${esc(b.title)}</strong><div class="muted small">${esc(b.isbn)}</div></td><td>${esc(b.author)}</td><td>${esc(b.category)}</td><td>${esc(b.location)}</td>
            <td>${b.available} / ${b.copies}</td>
            <td><div class="actions"><button class="btn ghost sm" data-edit="${b.id}">Sửa</button><button class="btn secondary sm" data-del="${b.id}" data-title="${esc(b.title)}">Xóa</button></div></td></tr>`).join("")}
          </tbody></table>`;
        const pages = Math.max(Math.ceil(d.total / per), 1);
        $("#pager").innerHTML = pages > 1 ? `<button class="btn ghost sm" id="pv" ${adminBooks.page <= 1 ? "disabled" : ""}>‹ Trước</button><span class="muted small">Trang ${adminBooks.page} / ${pages} · ${d.total} đầu sách</span><button class="btn ghost sm" id="nx" ${adminBooks.page >= pages ? "disabled" : ""}>Sau ›</button>` : `<span class="muted small">${d.total} đầu sách</span>`;
        const pv = $("#pv"), nx = $("#nx");
        if (pv) pv.onclick = () => { adminBooks.page--; load(); };
        if (nx) nx.onclick = () => { adminBooks.page++; load(); };
        box.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => bookForm(d.items.find((x) => x.id === Number(b.dataset.edit)), load)));
        box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
          if (!confirm(`Xóa sách “${b.dataset.title}”?`)) return;
          try { await api("/api/admin/books/" + b.dataset.del, { method: "DELETE" }); toast("Đã xóa sách."); load(); }
          catch (e) { toast(e.message, true); }
        }));
      } catch (e) { $("#box").innerHTML = `<div class="alert-box error">${esc(e.message)}</div>`; }
    }
    viewAdminBooks.reload = load;
    load();
  }

  function bookForm(b) {
    const v = (k) => esc(b && b[k] != null ? b[k] : "");
    openModal(`<h2>${b ? "Sửa thông tin sách" : "Thêm sách mới"}</h2><div id="msg"></div>
      <form id="bf">
        <div class="field"><label for="t">Tên sách *</label><input id="t" required maxlength="250" value="${v("title")}"></div>
        <div class="grid2">
          <div class="field"><label for="a">Tác giả</label><input id="a" maxlength="200" value="${v("author")}"></div>
          <div class="field"><label for="c">Thể loại</label><input id="c" maxlength="100" value="${v("category")}" list="catlist"></div>
          <div class="field"><label for="i">ISBN</label><input id="i" maxlength="30" value="${v("isbn")}"></div>
          <div class="field"><label for="p">Nhà xuất bản</label><input id="p" maxlength="150" value="${v("publisher")}"></div>
          <div class="field"><label for="y">Năm xuất bản</label><input id="y" type="number" min="1000" max="2100" value="${v("year")}"></div>
          <div class="field"><label for="n">Số bản</label><input id="n" type="number" min="0" max="9999" value="${b ? v("copies") : 1}"></div>
          <div class="field"><label for="l">Vị trí trên kệ</label><input id="l" maxlength="60" value="${v("location")}" placeholder="Ví dụ: Kệ A1"></div>
        </div>
        <div class="field"><label for="d">Mô tả</label><textarea id="d" maxlength="2000">${v("description")}</textarea></div>
        <div class="btns"><button type="button" class="btn ghost" id="mNo">Đóng</button><button class="btn">${b ? "Lưu thay đổi" : "Thêm sách"}</button></div>
      </form>`, () => {
      $("#mNo").onclick = closeModal;
      $("#bf").onsubmit = async (e) => {
        e.preventDefault();
        const body = { title: $("#t").value, author: $("#a").value, category: $("#c").value, isbn: $("#i").value,
          publisher: $("#p").value, year: $("#y").value, copies: $("#n").value, location: $("#l").value, description: $("#d").value };
        try {
          await api(b ? "/api/admin/books/" + b.id : "/api/admin/books", { method: b ? "PUT" : "POST", json: body });
          closeModal(); toast(b ? "Đã lưu thay đổi." : "Đã thêm sách."); if (viewAdminBooks.reload) viewAdminBooks.reload();
        } catch (er) { $("#msg").innerHTML = `<div class="alert-box error">${esc(er.message)}</div>`; }
      };
    });
  }

  function importForm() {
    openModal(`<h2>Nhập sách từ tệp CSV</h2><div id="msg"></div>
      <p class="small">Tệp CSV mã hóa UTF-8, dòng đầu là tên cột. Cột bắt buộc: <code>Tên sách</code>. Các cột tùy chọn:
      <code>Tác giả</code>, <code>Thể loại</code>, <code>ISBN</code>, <code>Nhà xuất bản</code>, <code>Năm xuất bản</code>, <code>Số bản</code>, <code>Vị trí</code>, <code>Mô tả</code>
      (hoặc tên tiếng Anh: title, author, category, isbn, publisher, year, copies, location, description). Nếu bỏ trống số bản, mặc định là 1.</p>
      <p class="small"><a href="#" id="tpl">Tải tệp mẫu</a></p>
      <div class="field"><label for="file">Chọn tệp</label><input id="file" type="file" accept=".csv,text/csv"></div>
      <div class="btns"><button class="btn ghost" id="mNo">Đóng</button><button class="btn" id="mYes">Nhập sách</button></div>`, () => {
      $("#mNo").onclick = closeModal;
      $("#tpl").onclick = (e) => {
        e.preventDefault();
        const csv = "﻿Tên sách,Tác giả,Thể loại,ISBN,Nhà xuất bản,Năm xuất bản,Số bản,Vị trí,Mô tả\r\nGiáo trình ví dụ,Nguyễn Văn A,Công nghệ thông tin,9780000000000,NXB Giáo dục,2023,3,Kệ A1,Mô tả ngắn\r\n";
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a"); a.href = url; a.download = "mau-nhap-sach.csv"; a.click(); URL.revokeObjectURL(url);
      };
      $("#mYes").onclick = async () => {
        const f = $("#file").files[0];
        if (!f) { $("#msg").innerHTML = `<div class="alert-box error">Vui lòng chọn tệp CSV.</div>`; return; }
        const fd = new FormData(); fd.append("file", f);
        try {
          const r = await api("/api/admin/books/import", { method: "POST", form: fd });
          $("#msg").innerHTML = `<div class="alert-box success">Đã thêm ${r.added} đầu sách.${r.skipped_count ? ` Bỏ qua ${r.skipped_count} dòng lỗi:<br>${r.skipped.map(esc).join("<br>")}` : ""}</div>`;
          if (viewAdminBooks.reload) viewAdminBooks.reload();
        } catch (er) { $("#msg").innerHTML = `<div class="alert-box error">${esc(er.message)}</div>`; }
      };
    });
  }

  // --- bạn đọc
  async function viewAdminUsers() {
    if (!needAdmin()) return;
    await refreshPending(); renderNav("users");
    appEl.innerHTML = `<div class="page-head"><h1>Bạn đọc</h1></div>
      <div class="toolbar"><input type="search" id="q" placeholder="Tìm theo tên, tên đăng nhập, mã SV, email…" aria-label="Tìm bạn đọc"></div>
      <div class="card table-wrap" id="box"></div>`;
    async function load(q) {
      try {
        const rows = await api("/api/admin/users?q=" + encodeURIComponent(q || ""));
        const box = $("#box");
        if (!rows.length) { box.innerHTML = `<div class="empty">Chưa có bạn đọc nào.</div>`; return; }
        box.innerHTML = `<table><thead><tr><th>Họ tên</th><th>Mã SV</th><th>Liên hệ</th><th>Đang mượn</th><th>Tổng lượt</th><th>Trạng thái</th><th></th></tr></thead><tbody>
          ${rows.map((u) => `<tr><td><strong>${esc(u.full_name)}</strong><div class="muted small">${esc(u.username)}</div></td><td>${esc(u.student_id) || "—"}</td><td>${esc(u.email) || "—"}</td>
            <td>${u.borrowing}${u.overdue ? ` <span class="badge overdue">${u.overdue} quá hạn</span>` : ""}</td><td>${u.total_loans}</td>
            <td>${u.active ? `<span class="badge ok">Hoạt động</span>` : `<span class="badge alert">Đã khóa</span>`}</td>
            <td><div class="actions"><button class="btn ghost sm" data-tg="${u.id}">${u.active ? "Khóa" : "Mở khóa"}</button><button class="btn ghost sm" data-pw="${u.id}" data-name="${esc(u.full_name)}">Đặt lại mật khẩu</button></div></td></tr>`).join("")}
        </tbody></table>`;
        box.querySelectorAll("[data-tg]").forEach((b) => (b.onclick = async () => {
          try { await api(`/api/admin/users/${b.dataset.tg}/toggle`, { method: "POST" }); toast("Đã cập nhật tài khoản."); load($("#q").value.trim()); }
          catch (e) { toast(e.message, true); }
        }));
        box.querySelectorAll("[data-pw]").forEach((b) => (b.onclick = () => resetPw(Number(b.dataset.pw), b.dataset.name)));
      } catch (e) { $("#box").innerHTML = `<div class="alert-box error">${esc(e.message)}</div>`; }
    }
    let timer;
    $("#q").oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => load(e.target.value.trim()), 300); };
    load("");
  }
  function resetPw(id, name) {
    openModal(`<h2>Đặt lại mật khẩu</h2><p>Bạn đọc: <strong>${esc(name)}</strong></p><div id="msg"></div>
      <div class="field"><label for="np">Mật khẩu mới (ít nhất 6 ký tự)</label><input id="np" type="text" autocomplete="off" minlength="6"></div>
      <div class="btns"><button class="btn ghost" id="mNo">Đóng</button><button class="btn" id="mYes">Đặt lại</button></div>`, () => {
      $("#mNo").onclick = closeModal;
      $("#mYes").onclick = async () => {
        try { await api(`/api/admin/users/${id}/reset-password`, { method: "POST", json: { new_password: $("#np").value } }); closeModal(); toast("Đã đặt lại mật khẩu."); }
        catch (e) { $("#msg").innerHTML = `<div class="alert-box error">${esc(e.message)}</div>`; }
      };
    });
  }

  // ---------- định tuyến ----------
  async function route() {
    closeModal();
    const h = (location.hash || "#/").replace(/^#/, "");
    const routes = {
      "/": viewHome, "/login": viewLogin, "/register": viewRegister, "/my": viewMy, "/account": viewAccount,
      "/admin": viewAdminHome, "/admin/requests": () => viewAdminLoans("requests"),
      "/admin/borrowing": () => viewAdminLoans("borrowing"), "/admin/books": viewAdminBooks, "/admin/users": viewAdminUsers,
    };
    const fn = routes[h] || viewHome;
    try { await fn(); } catch (e) { appEl.innerHTML = `<div class="alert-box error">${esc(e.message)}</div>`; }
    window.scrollTo(0, 0);
    appEl.focus({ preventScroll: true });
  }

  async function boot() {
    try {
      const me = await api("/api/me");
      state.user = me.user; state.loanDays = me.loan_days; state.maxLoans = me.max_loans;
    } catch (e) { /* khách */ }
    window.addEventListener("hashchange", route);
    route();
  }
  boot();
})();
