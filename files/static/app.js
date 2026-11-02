(() => {
  "use strict";

  // Set to false to list oldest notes first (pinned notes always stay on top).
  const NEWEST_FIRST = true;
  const REFRESH_MS = 30000;

  const $ = (id) => document.getElementById(id);

  const grid = $("grid");
  const emptyMsg = $("empty");

  const composeBtn = $("compose-btn");
  const composer = $("composer");
  const noteForm = $("note-form");
  const noteStatus = $("note-status");

  const adminLoginBtn = $("admin-login-btn");
  const selectBtn = $("select-btn");
  const logoutBtn = $("logout-btn");
  const loginDialog = $("login");
  const loginForm = $("login-form");
  const loginStatus = $("login-status");

  const viewer = $("viewer");
  const viewerTitle = $("viewer-title");
  const viewerNote = $("viewer-note");
  const repliesHeading = $("replies-heading");
  const viewerReplies = $("viewer-replies");
  const replyForm = $("reply-form");
  const replyStatus = $("reply-status");

  const gridBar = $("grid-bar");
  const viewerBar = $("viewer-bar-admin");
  const bars = document.querySelectorAll(".selection-bar");

  let notes = [];
  let openId = null;
  let admin = false;
  let selectMode = false;
  const selected = new Set(); // "n:<noteId>" or "r:<noteId>:<replyId>"

  const noteKey = (id) => "n:" + id;
  const replyKey = (noteId, replyId) => "r:" + noteId + ":" + replyId;

  // ---- helpers ----

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function timeEl(iso) {
    const node = el("time", "stamp", formatDate(iso));
    node.dateTime = iso;
    return node;
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function countLabel(n) {
    return n === 1 ? "1 Antwort" : n + " Antworten";
  }

  async function api(path, options) {
    const response = await fetch(path, options);
    let data = null;
    try {
      data = await response.json();
    } catch (_) { /* ignore */ }
    if (!response.ok) {
      const err = new Error((data && data.error) || "Request failed.");
      err.status = response.status;
      throw err;
    }
    return data;
  }

  function postJson(path, payload) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  function setStatus(node, message, isError) {
    node.textContent = message;
    node.classList.toggle("error", Boolean(isError));
  }

  function findNote(id) {
    return notes.find((n) => n.id === id) || null;
  }

  // ---- dialogs ----

  function openDialog(dialog) {
    document.body.classList.add("locked");
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog(dialog) {
    if (dialog.open) dialog.close();
  }

  document.querySelectorAll("dialog").forEach((dialog) => {
    // A click on the dimmed backdrop (the dialog element itself) closes it.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      if (!document.querySelector("dialog[open]")) {
        document.body.classList.remove("locked");
      }
    });
  });

  viewer.addEventListener("close", () => {
    openId = null;
    selected.clear();
    updateBars();
  });

  $("viewer-close").addEventListener("click", () => closeDialog(viewer));
  $("composer-cancel").addEventListener("click", () => closeDialog(composer));
  $("login-cancel").addEventListener("click", () => closeDialog(loginDialog));

  // ---- selection state ----

  function selectedNoteIds() {
    return [...selected].filter((k) => k.startsWith("n:")).map((k) => k.slice(2));
  }

  function selectedReplies() {
    return [...selected]
      .filter((k) => k.startsWith("r:"))
      .map((k) => {
        const [, note, reply] = k.split(":");
        return { note, reply };
      });
  }

  function pruneSelection() {
    const valid = new Set();
    for (const note of notes) {
      valid.add(noteKey(note.id));
      for (const reply of note.replies) valid.add(replyKey(note.id, reply.id));
    }
    for (const key of [...selected]) {
      if (!valid.has(key)) selected.delete(key);
    }
  }

  function updateBars() {
    const noteIds = selectedNoteIds();
    const replyCount = selectedReplies().length;
    const total = noteIds.length + replyCount;
    const allPinned =
      noteIds.length > 0 && noteIds.every((id) => (findNote(id) || {}).pinned);

    for (const bar of bars) {
      bar.querySelector("[data-count]").textContent = total + " ausgewählt";
      bar.querySelector('[data-act="delete"]').disabled = total === 0;
      const pin = bar.querySelector('[data-act="pin"]');
      pin.disabled = noteIds.length === 0;
      pin.textContent = allPinned ? "Unpin" : "Pin";
      const clear = bar.querySelector('[data-act="clear"]');
      if (clear) clear.disabled = total === 0;
    }
  }

  // ---- admin UI state ----

  function updateAdminUI() {
    adminLoginBtn.hidden = admin;
    selectBtn.hidden = !admin || selectMode;
    logoutBtn.hidden = !admin;
    composeBtn.hidden = selectMode;
    gridBar.hidden = !(admin && selectMode);
    viewerBar.hidden = !admin;
    document.body.classList.toggle("select-mode", selectMode);

    renderGrid();
    const note = openId && findNote(openId);
    if (note) renderViewer(note);
    updateBars();
  }

  function dropAdmin() {
    admin = false;
    selectMode = false;
    selected.clear();
    updateAdminUI();
  }

  function openLogin(message) {
    loginForm.reset();
    setStatus(loginStatus, message || "", false);
    openDialog(loginDialog);
    loginForm.elements.password.focus();
  }

  adminLoginBtn.addEventListener("click", () => openLogin(""));

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = loginForm.querySelector("button[type=submit]");
    submit.disabled = true;
    setStatus(loginStatus, "Checking...", false);
    try {
      await postJson("/api/login", { password: loginForm.elements.password.value });
      admin = true;
      loginForm.reset();
      closeDialog(loginDialog);
      updateAdminUI();
    } catch (err) {
      setStatus(loginStatus, err.message, true);
      loginForm.elements.password.select();
    } finally {
      submit.disabled = false;
    }
  });

  logoutBtn.addEventListener("click", async () => {
    try {
      await postJson("/api/logout", {});
    } catch (_) { /* session is dropped locally either way */ }
    dropAdmin();
  });

  selectBtn.addEventListener("click", () => {
    selectMode = true;
    updateAdminUI();
  });

  // ---- grid ----

  function sortedNotes() {
    const list = notes.slice().sort((a, b) => a.created.localeCompare(b.created));
    if (NEWEST_FIRST) list.reverse();
    return list.filter((n) => n.pinned).concat(list.filter((n) => !n.pinned));
  }

  function renderGrid() {
    const list = sortedNotes();
    emptyMsg.hidden = list.length > 0;

    const fragment = document.createDocumentFragment();
    for (const note of list) fragment.appendChild(buildCard(note));
    grid.replaceChildren(fragment);
  }

  function buildCard(note) {
    const isSelected = selectMode && selected.has(noteKey(note.id));

    const card = el("article", "card");
    if (note.pinned) card.classList.add("pinned");
    if (isSelected) card.classList.add("selected");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.dataset.id = note.id;
    if (selectMode) card.setAttribute("aria-pressed", String(isSelected));

    const head = el("div", "card-head");
    const left = el("div", "head-left");
    if (selectMode) left.appendChild(el("span", "check"));
    if (note.pinned) left.appendChild(el("span", "badge", "Pinned"));
    left.appendChild(timeEl(note.created));
    head.appendChild(left);
    head.appendChild(el("span", "", countLabel(note.replies.length)));
    card.appendChild(head);

    const main = el("div", "card-main");
    main.appendChild(el("h3", "", note.title));
    main.appendChild(el("p", "clamp", note.content));
    card.appendChild(main);

    if (note.replies.length > 0) {
      const last = note.replies[note.replies.length - 1];
      const latest = el("div", "card-latest");
      const latestHead = el("div", "latest-head");
      latestHead.appendChild(el("span", "label", "Neuste Antwort"));
      latestHead.appendChild(timeEl(last.created));
      latest.appendChild(latestHead);
      latest.appendChild(el("p", "clamp", last.content));
      card.appendChild(latest);
    }

    return card;
  }

  function activateCard(card) {
    const id = card.dataset.id;
    if (!selectMode) {
      openNote(id);
      return;
    }
    const key = noteKey(id);
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    const on = selected.has(key);
    card.classList.toggle("selected", on);
    card.setAttribute("aria-pressed", String(on));
    updateBars();
  }

  grid.addEventListener("click", (event) => {
    const card = event.target.closest(".card");
    if (card) activateCard(card);
  });

  grid.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".card");
    if (!card) return;
    event.preventDefault();
    activateCard(card);
  });

  // ---- viewer ----

  function buildPick(key) {
    const label = el("label", "pick");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selected.has(key);
    input.addEventListener("change", () => {
      if (input.checked) selected.add(key);
      else selected.delete(key);
      const block = label.closest(".block");
      if (block) block.classList.toggle("selected", input.checked);
      updateBars();
    });
    label.appendChild(input);
    label.appendChild(el("span", "visually-hidden", "Select"));
    return label;
  }

  function renderViewer(note) {
    viewerTitle.textContent = 'Frage';

    const noteHead = el("div", "block-head");
    if (admin) noteHead.appendChild(buildPick(noteKey(note.id)));
    noteHead.appendChild(el("span", "block-label", note.title));
    if (note.pinned) noteHead.appendChild(el("span", "badge", "Pinned"));
    noteHead.appendChild(timeEl(note.created));
    viewerNote.classList.toggle("selected", admin && selected.has(noteKey(note.id)));
    viewerNote.replaceChildren(noteHead, el("p", "block-text", note.content));

    repliesHeading.textContent = "Antworten (" + note.replies.length + ")";

    if (note.replies.length === 0) {
      viewerReplies.replaceChildren(
        el("li", "no-replies", "No replies yet. Be the first to answer.")
      );
      return;
    }

    const items = note.replies.map((reply, index) => {
      const key = replyKey(note.id, reply.id);
      const li = el("li", "block reply-block");
      li.classList.toggle("selected", admin && selected.has(key));

      const head = el("div", "block-head");
      if (admin) head.appendChild(buildPick(key));
      head.appendChild(el("span", "block-label", "Antwort " + (index + 1)));
      head.appendChild(timeEl(reply.created));

      li.appendChild(head);
      li.appendChild(el("p", "block-text", reply.content));
      return li;
    });
    viewerReplies.replaceChildren(...items);
  }

  function openNote(id) {
    const note = findNote(id);
    if (!note) return;
    selected.clear();
    openId = id;
    renderViewer(note);
    updateBars();
    setStatus(replyStatus, "", false);
    replyForm.reset();
    openDialog(viewer);
    viewer.scrollTop = 0;
  }

  // ---- admin actions ----

  async function adminAction(path, payload) {
    try {
      await postJson(path, payload);
    } catch (err) {
      if (err.status === 401) {
        dropAdmin();
        openLogin("Session expired. Log in again.");
      } else {
        window.alert(err.message);
      }
      return;
    }
    selected.clear();
    await refresh();
  }

  async function doPin() {
    const ids = selectedNoteIds();
    if (ids.length === 0) return;
    const pinned = !ids.every((id) => (findNote(id) || {}).pinned);
    await adminAction("/api/pin", { ids, pinned });
  }

  async function doDelete() {
    const noteIds = selectedNoteIds();
    const replies = selectedReplies();
    if (noteIds.length + replies.length === 0) return;

    const parts = [];
    if (noteIds.length === 1) parts.push("1 note (with all its replies)");
    else if (noteIds.length > 1) parts.push(noteIds.length + " notes (with all their replies)");
    if (replies.length === 1) parts.push("1 reply");
    else if (replies.length > 1) parts.push(replies.length + " replies");

    if (!window.confirm("Delete " + parts.join(" and ") + "? This cannot be undone.")) return;
    await adminAction("/api/delete", { notes: noteIds, replies });
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    if (!button || !button.closest(".selection-bar")) return;

    switch (button.dataset.act) {
      case "pin":
        doPin();
        break;
      case "delete":
        doDelete();
        break;
      case "clear": {
        selected.clear();
        const note = openId && findNote(openId);
        if (note) renderViewer(note);
        updateBars();
        break;
      }
      case "done":
        selectMode = false;
        selected.clear();
        updateAdminUI();
        break;
    }
  });

  // ---- data ----

  async function refresh() {
    try {
      notes = await api("/api/notes");
    } catch (_) {
      return; // keep showing what we have; try again on the next refresh
    }
    pruneSelection();
    renderGrid();
    if (openId) {
      const note = findNote(openId);
      if (note) renderViewer(note);
      else closeDialog(viewer); // the open note was deleted
    }
    updateBars();
  }

  // ---- posting ----

  composeBtn.addEventListener("click", () => {
    setStatus(noteStatus, "", false);
    openDialog(composer);
    noteForm.elements.title.focus();
  });

  noteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = noteForm.querySelector("button[type=submit]");
    submit.disabled = true;
    setStatus(noteStatus, "Posting...", false);
    try {
      await postJson("/api/notes", {
        title: noteForm.elements.title.value,
        content: noteForm.elements.content.value,
      });
      noteForm.reset();
      closeDialog(composer);
      await refresh();
    } catch (err) {
      setStatus(noteStatus, err.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  replyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!openId) return;
    const submit = replyForm.querySelector("button[type=submit]");
    submit.disabled = true;
    setStatus(replyStatus, "Posting...", false);
    try {
      await postJson("/api/notes/" + openId + "/replies", {
        content: replyForm.elements.content.value,
      });
      replyForm.reset();
      setStatus(replyStatus, "Posted.", false);
      await refresh();
    } catch (err) {
      setStatus(replyStatus, err.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  // ---- start ----

  async function init() {
    try {
      const session = await api("/api/session");
      admin = Boolean(session.admin);
    } catch (_) { /* treat as logged out */ }
    await refresh();
    updateAdminUI();
  }

  init();
  setInterval(refresh, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
})();
