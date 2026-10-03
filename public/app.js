const state = {
  view: 'now',
  previousView: 'now',
  overview: null,
  overviewRequestId: 0,
  selectedSessionId: null,
  selectedPaneId: null,
  selectedSession: null,
  sessionRequestId: 0,
  sessionRefreshRequestId: 0,
  latestMessages: [],
  olderMessages: [],
  messageTotal: 0,
  hasOlderMessages: false,
  loadingEarlier: false,
  search: '',
  projectFilter: null,
  historySessions: [],
  historyOffset: 0,
  historyTotal: 0,
  historyLoading: false,
  historyError: '',
  historyRequestId: 0,
  historySearchTimer: null,
  clips: [],
  clipsRequestId: 0,
  composerDrafts: new Map(),
  clipDraft: '',
  sending: false,
  loadingSession: false,
  scrollToBottom: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const main = $('#main-content');
const title = $('#page-title');
const toastRoot = $('#toast-root');
const appShell = $('.app-shell');

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function button(label, className, action, attrs = {}) {
  const node = el('button', className, label);
  node.type = 'button';
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.addEventListener('click', action);
  return node;
}

function icon(name, className = '') {
  return el('i', `ph ph-${name}${className ? ` ${className}` : ''}`);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    cache: 'no-store',
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401 && location.pathname !== '/login') location.replace('/login');
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload;
}

function toast(message, isError = false) {
  const node = el('div', `toast${isError ? ' error' : ''}`, message);
  toastRoot.append(node);
  setTimeout(() => node.remove(), 3600);
}

function composerDraft(sessionId = state.selectedSessionId) {
  const key = sessionId || state.selectedPaneId || 'unsaved';
  if (!state.composerDrafts.has(key)) state.composerDrafts.set(key, { text: '', attachments: [] });
  return state.composerDrafts.get(key);
}

function formatTime(value, withDate = false) {
  if (!value) return '—';
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat('en', withDate || !sameDay
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { hour: 'numeric', minute: '2-digit' }).format(date);
}

function timeAgo(value) {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - Number(value)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function humanBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function statusLabel(status) {
  return ({ working: 'Thinking', blocked: 'Needs you', idle: 'Ready', done: 'Done', unknown: 'Live', history: 'History' })[status] || status || 'Unknown';
}

function setConnection(online, text = '') {
  const node = $('#connection-state');
  node.classList.toggle('is-offline', !online);
  node.lastChild.textContent = text || (online ? (window.isSecureContext ? 'Clipboard ready' : 'Private · limited clipboard') : 'Reconnecting');
}

function setView(view) {
  state.view = view;
  if (view === 'now') state.projectFilter = null;
  state.selectedSessionId = null;
  state.selectedPaneId = null;
  state.selectedSession = null;
  document.body.dataset.page = view;
  title.textContent = ({ now: 'Home', history: 'History', clips: 'Clipboard' })[view] || 'Conversation';
  if (['now', 'history', 'clips'].includes(view)) history.replaceState(null, '', `#${view}`);
  const activeView = view === 'chat' ? state.previousView : view;
  document.querySelectorAll('[data-view]').forEach((node) => node.classList.toggle('is-active', node.dataset.view === activeView));
  renderSidebar();
  closeSidebar();
  render();
  if (view === 'history') loadHistory(true);
  if (view === 'clips') loadClips();
}

function updateNavCounts() {
  const live = state.overview?.agents?.filter((agent) => ['working', 'blocked'].includes(agent.status)).length || 0;
  $('#live-count').textContent = String(live);
}

function renderSidebar() {
  const projects = $('#sidebar-projects');
  const recents = $('#sidebar-recents');
  if (!projects || !recents) return;
  projects.replaceChildren();
  recents.replaceChildren();

  const directories = (state.overview?.directories || []).filter((item) => !/^\/(?:home|Users)\/[^/]+$/.test(item.directory || ''));
  for (const item of directories) {
    const link = button(item.name, `sidebar-link${state.projectFilter === item.directory ? ' is-selected' : ''}`, () => {
      state.projectFilter = item.directory;
      state.search = '';
      state.view = 'history';
      state.selectedSessionId = null;
      state.selectedSession = null;
      document.body.dataset.page = 'history';
      title.textContent = item.name;
      history.replaceState(null, '', '#history');
      document.querySelectorAll('[data-view]').forEach((node) => node.classList.toggle('is-active', node.dataset.view === 'history'));
      renderSidebar();
      closeSidebar();
      render();
      loadHistory(true);
    });
    const projectIcon = el('span', 'sidebar-project-icon');
    projectIcon.append(icon('folder-simple'));
    const label = el('span', 'sidebar-link-label', item.name);
    link.replaceChildren(projectIcon, label);
    projects.append(link);
  }
  if (!directories.length) projects.append(el('div', 'sidebar-empty', 'Projects will appear here'));

  const liveBySession = new Map((state.overview?.agents || []).filter((item) => item.sessionId).map((item) => [item.sessionId, item]));
  for (const session of (state.overview?.sessions || []).slice(0, 9)) {
    const live = liveBySession.get(session.id);
    const link = button('', `sidebar-link sidebar-recent${state.selectedSessionId === session.id ? ' is-selected' : ''}`, () => openSession(session.id, live?.paneId));
    link.append(el('span', `recent-agent-dot ${live?.status || ''}`));
    link.append(el('span', 'sidebar-link-label', session.title || 'Untitled task'));
    recents.append(link);
  }
  if (!state.overview?.sessions?.length) recents.append(el('div', 'sidebar-empty', 'No recent tasks'));
}

function closeSidebar() {
  document.querySelector('.app-shell')?.classList.remove('sidebar-open');
}

function openSidebar() {
  document.querySelector('.app-shell')?.classList.add('sidebar-open');
}

function renderSystemCard(system) {
  const card = el('section', 'system-card');
  const intro = el('div', 'system-intro');
  intro.append(el('strong', '', 'VPS status'));
  intro.append(el('p', '', 'Live resource use'));
  card.append(intro);

  const used = Number(system?.memoryUsed || 0);
  const total = Number(system?.memoryTotal || 1);
  const pct = Math.max(0, Math.min(100, Math.round(used / total * 100)));
  const memory = el('div', 'stat');
  memory.append(el('span', 'stat-label', 'Memory'));
  memory.append(el('strong', 'stat-value', `${humanBytes(used)} / ${humanBytes(total)}`));
  const meter = el('progress', `memory-meter${pct > 90 ? ' hot' : pct > 78 ? ' warn' : ''}`);
  meter.max = 100; meter.value = pct; meter.setAttribute('aria-label', `Memory ${pct}% used`); memory.append(meter);
  card.append(memory);

  const swapUsed = Number(system?.swap?.used || 0);
  const swapTotal = Number(system?.swap?.total || 1);
  const swap = el('div', 'stat');
  swap.append(el('span', 'stat-label', 'Swap used'));
  swap.append(el('strong', 'stat-value', `${humanBytes(swapUsed)}`));
  swap.append(el('span', 'stat-note', `of ${humanBytes(swapTotal)}`));
  card.append(swap);

  const load = Number(system?.load?.[0] || 0);
  const cores = Number(system?.cpuCount || 2);
  const loadCard = el('div', 'stat');
  loadCard.append(el('span', 'stat-label', 'Load · 1 min'));
  const loadValue = el('strong', 'stat-value', load.toFixed(1));
  loadValue.append(el('span', 'stat-note', ` / ${cores} cores`));
  loadCard.append(loadValue);
  card.append(loadCard);
  return card;
}

function renderAgentCard(agent) {
  const card = el('article', 'agent-card');
  const top = el('div', 'agent-card-top');
  const orb = el('span', `status-orb ${agent.status}`);
  const heading = el('div', 'agent-heading');
  heading.append(el('div', 'agent-title', agent.sessionTitle || agent.title || agent.agent));
  heading.append(el('div', 'agent-meta', `${agent.agent || 'agent'} · ${agent.cwd?.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~') || agent.paneId}`));
  const pill = el('span', `status-pill ${agent.status}`, statusLabel(agent.status));
  top.append(orb, heading, pill);
  card.append(top);
  card.append(el('div', 'agent-project', `${statusLabel(agent.status)}${agent.updated ? ` · updated ${timeAgo(agent.updated)}` : ''}`));
  const actions = el('div', 'agent-card-actions');
  if (agent.sessionId) actions.append(button('Open chat', 'small-button', () => openSession(agent.sessionId, agent.paneId)));
  actions.append(button('Read live output', 'small-button', () => showOutput(agent)));
  card.append(actions);
  return card;
}

function renderSessionCard(session) {
  const card = el('button', 'session-card');
  card.type = 'button';
  card.addEventListener('click', () => openSession(session.id));
  const mark = el('span', 'session-mark');
  mark.append(icon(session.live ? 'chat-circle-dots' : 'arrow-up-right'));
  card.append(mark);
  const content = el('span', 'session-main');
  content.append(el('span', 'session-title', session.title || 'Untitled session'));
  content.append(el('span', 'session-preview', session.preview || `${session.agent || 'OpenCode'} · No text preview`));
  card.append(content);
  const tail = el('span', 'session-tail');
  tail.append(el('span', 'directory-chip', session.directory?.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~') || '~/'));
  tail.append(el('span', '', timeAgo(session.updated)));
  card.append(tail);
  return card;
}

function sectionHead(heading, description, label = '') {
  const wrap = el('div', 'section-head');
  const text = el('div');
  if (label) text.append(el('div', 'section-label', label));
  text.append(el('h2', '', heading));
  if (description) text.append(el('p', '', description));
  wrap.append(text);
  return wrap;
}

function renderNow() {
  if (!state.overview) return renderLoading();
  main.replaceChildren();
  const view = el('div', 'home-view');
  const heading = el('div', 'home-heading');
  heading.append(el('h2', '', 'Your work'));
  heading.append(el('p', '', 'Pick up a task or see what your agents are doing.'));
  view.append(heading, renderSystemCard(state.overview.system));

  const activeAgents = (state.overview.agents || []).filter((agent) => agent.status !== 'done');
  const section = el('section', 'section-block');
  section.append(sectionHead('In progress', activeAgents.length ? `${activeAgents.length} live agent${activeAgents.length === 1 ? '' : 's'}` : 'No live agents'));
  if (activeAgents.length) {
    const grid = el('div', 'agent-grid');
    for (const agent of activeAgents) grid.append(renderAgentCard(agent));
    section.append(grid);
  } else {
    const empty = el('div', 'empty-card', 'Start a new task when the VPS has room, or continue a conversation from History.');
    section.append(empty);
  }
  view.append(section);

  const recent = (state.overview.sessions || []).slice(0, 6);
  const recentSection = el('section', 'section-block recent-section');
  recentSection.append(sectionHead('Recent tasks', 'Your latest conversations across projects.'));
  const list = el('div', 'session-list');
  for (const session of recent) list.append(renderSessionCard(session));
  if (!recent.length) list.append(el('div', 'empty-card', 'Your conversation history will appear here.'));
  recentSection.append(list);
  view.append(recentSection);
  main.append(view);
}

function renderHistory() {
  main.replaceChildren();
  const view = el('div', 'history-view');
  const heading = el('div', 'home-heading');
  const selectedProject = state.overview?.directories?.find((item) => item.directory === state.projectFilter);
  heading.append(el('h2', '', selectedProject ? selectedProject.name : 'History'));
  heading.append(el('p', '', selectedProject ? 'Past and active conversations in this project.' : 'Search and reopen any saved conversation.'));
  view.append(heading);
  const toolbar = el('div', 'history-toolbar');
  const search = el('label', 'search-box');
  search.append(icon('magnifying-glass', 'search-icon'));
  const input = el('input');
  input.type = 'search';
  input.placeholder = 'Search tasks';
  input.value = state.search;
  input.setAttribute('aria-label', 'Search conversations');
  input.addEventListener('input', () => {
    state.search = input.value;
    scheduleHistorySearch();
  });
  search.append(input);
  toolbar.append(search);
  if (state.projectFilter) {
    const clearFilter = button('Clear project filter', 'filter-chip', () => {
      state.projectFilter = null;
      renderSidebar();
      render();
      loadHistory(true);
    });
    clearFilter.append(icon('x'));
    toolbar.append(clearFilter);
  }
  view.append(toolbar, el('div', 'history-results'));
  main.append(view);
  renderHistoryList();
}

function renderHistoryList() {
  const host = $('.history-results', main);
  if (!host) return;
  host.replaceChildren();
  if (state.historyError) {
    host.append(el('div', 'error-card', state.historyError));
    return;
  }
  const matches = state.historySessions;
  if (!matches.length && state.historyLoading) {
    host.append(el('div', 'loading-card', 'Loading history…'));
    return;
  }
  if (!matches.length) {
    host.append(el('div', 'empty-card', state.search ? 'No conversations match that search.' : 'No saved conversations yet.'));
    return;
  }
  const groups = new Map();
  for (const session of matches) {
    const day = new Date(Number(session.updated || session.created)).toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' });
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(session);
  }
  for (const [day, items] of groups) {
    const group = el('section', 'history-group');
    group.append(el('h2', 'history-group-title', day));
    const list = el('div', 'session-list');
    for (const item of items) list.append(renderSessionCard(item));
    group.append(list);
    host.append(group);
  }
  if (state.historyOffset < state.historyTotal) {
    const more = button(state.historyLoading ? 'Loading…' : 'Load more', 'button button-quiet history-load-more', () => loadHistory(false));
    more.disabled = state.historyLoading;
    host.append(more);
  }
}

function scheduleHistorySearch() {
  const requestId = ++state.historyRequestId;
  clearTimeout(state.historySearchTimer);
  state.historySessions = [];
  state.historyOffset = 0;
  state.historyTotal = 0;
  state.historyError = '';
  state.historyLoading = true;
  renderHistoryList();
  state.historySearchTimer = setTimeout(() => loadHistory(true, requestId), 250);
}

async function loadHistory(reset = true, requestId = null) {
  const currentRequest = requestId ?? ++state.historyRequestId;
  if (reset) {
    state.historySessions = [];
    state.historyOffset = 0;
    state.historyTotal = 0;
    state.historyError = '';
  }
  state.historyLoading = true;
  if (state.view === 'history') renderHistoryList();

  const params = new URLSearchParams({ limit: '100', offset: String(reset ? 0 : state.historyOffset) });
  const query = state.search.trim();
  if (query) params.set('q', query);
  if (state.projectFilter) params.set('directory', state.projectFilter);

  try {
    const payload = await api(`/api/sessions?${params}`);
    if (currentRequest !== state.historyRequestId) return;
    const incoming = payload.sessions || [];
    state.historySessions = reset ? incoming : [...state.historySessions, ...incoming];
    state.historyOffset = state.historySessions.length;
    state.historyTotal = Number(payload.total || 0);
  } catch (error) {
    if (currentRequest === state.historyRequestId) state.historyError = error.message;
  } finally {
    if (currentRequest === state.historyRequestId) {
      state.historyLoading = false;
      if (state.view === 'history') renderHistoryList();
    }
  }
}

async function openSession(sessionId, paneId = null) {
  const requestId = ++state.sessionRequestId;
  state.sessionRefreshRequestId += 1;
  closeSidebar();
  state.previousView = state.view === 'chat' ? state.previousView : state.view;
  state.view = 'chat';
  document.body.dataset.page = 'chat';
  state.selectedSessionId = sessionId;
  state.selectedPaneId = paneId || state.overview?.agents?.find((agent) => agent.sessionId === sessionId)?.paneId || null;
  state.selectedSession = null;
  state.latestMessages = [];
  state.olderMessages = [];
  state.messageTotal = 0;
  state.hasOlderMessages = false;
  state.loadingEarlier = false;
  state.loadingSession = true;
  state.scrollToBottom = true;
  title.textContent = 'Task';
  renderSidebar();
  render();
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(sessionId)}?offset=0`);
    if (requestId !== state.sessionRequestId || state.selectedSessionId !== sessionId) return;
    state.selectedSession = payload.session;
    state.latestMessages = payload.session.messages || [];
    state.messageTotal = Number(payload.session.messageTotal || state.latestMessages.length);
    state.hasOlderMessages = Boolean(payload.session.hasMoreMessages);
  } catch (error) {
    if (requestId === state.sessionRequestId) toast(error.message, true);
  } finally {
    if (requestId === state.sessionRequestId) {
      state.loadingSession = false;
      renderChat();
    }
  }
}

function textFromParts(parts = []) {
  return parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
}

function appendInline(parent, text) {
  const pattern = /(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>]+|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_)/g;
  let cursor = 0;
  for (const match of String(text).matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parent.append(document.createTextNode(text.slice(cursor, index)));
    const token = match[0];
    const markdownLink = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
    if (markdownLink) {
      const anchor = el('a', '', markdownLink[1]);
      anchor.href = markdownLink[2].replace(/[.,!?]+$/, '');
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      parent.append(anchor);
    } else if (/^https?:\/\//.test(token)) {
      const url = token.replace(/[.,!?]+$/, '');
      const anchor = el('a', '', url);
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      parent.append(anchor);
      if (url.length < token.length) parent.append(document.createTextNode(token.slice(url.length)));
    } else if (token.startsWith('`')) {
      parent.append(el('code', 'inline-code', token.slice(1, -1)));
    } else if (token.startsWith('**') || token.startsWith('__')) {
      parent.append(el('strong', '', token.slice(2, -2)));
    } else if (token.startsWith('~~')) {
      parent.append(el('del', '', token.slice(2, -2)));
    } else if (token.startsWith('*') || token.startsWith('_')) {
      parent.append(el('em', '', token.slice(1, -1)));
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function isMarkdownBlockStart(line) {
  return /^(?:```|#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>\s?|\s*[-*_]{3,}\s*)/.test(line);
}

function appendCodeBlock(parent, language, code) {
  const codeWrap = el('div', 'code-wrap');
  codeWrap.append(el('div', 'code-label', language || 'Code'));
  const pre = el('pre');
  pre.append(el('code', '', code));
  codeWrap.append(pre);
  codeWrap.append(button('Copy', 'code-copy', async () => {
    try { await copyText(code); toast('Copied to clipboard'); }
    catch (error) { toast(error.message, true); }
  }));
  parent.append(codeWrap);
}

function renderTextBlock(text) {
  const root = el('div', 'markdown');
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = /^\s*```([^`]*)$/.exec(line);
    if (fence) {
      const language = fence[1].trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      appendCodeBlock(root, language, code.join('\n'));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const node = el(`h${heading[1].length}`, '', '');
      appendInline(node, heading[2].replace(/\s+#+\s*$/, ''));
      root.append(node);
      index += 1;
      continue;
    }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) { root.append(el('hr')); index += 1; continue; }
    if (/^\s*>/.test(line)) {
      const quote = el('blockquote');
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        const row = el('p');
        appendInline(row, lines[index++].replace(/^\s*>\s?/, ''));
        quote.append(row);
      }
      root.append(quote);
      continue;
    }
    const listMatch = /^\s*([-*+]\s+|\d+[.)]\s+)(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const list = el(ordered ? 'ol' : 'ul');
      const marker = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      while (index < lines.length) {
        const itemMatch = marker.exec(lines[index]);
        if (!itemMatch) break;
        const item = el('li');
        appendInline(item, lines[index++].replace(marker, ''));
        list.append(item);
      }
      root.append(list);
      continue;
    }
    const paragraph = el('p');
    const content = [];
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) content.push(lines[index++]);
    if (!content.length) { content.push(line); index += 1; }
    content.forEach((row, rowIndex) => {
      if (rowIndex) paragraph.append(document.createElement('br'));
      appendInline(paragraph, row);
    });
    root.append(paragraph);
  }
  return root;
}

function renderMessage(message) {
  const role = message.info?.role === 'user' ? 'user' : 'assistant';
  const card = el('article', `message ${role}`);
  const head = el('div', 'message-head');
  head.append(el('span', '', role === 'user' ? 'You' : 'Assistant'));
  head.append(el('time', '', formatTime(message.created)));
  const text = textFromParts(message.parts);
  if (text) head.append(button('Copy', 'message-copy', async () => {
    try { await copyText(text); toast('Copied to clipboard'); }
    catch (error) { toast(error.message, true); }
  }));
  card.append(head);
  for (const part of message.parts || []) {
    if (part.type === 'text' && part.text) card.append(renderTextBlock(part.text));
    else if (part.type === 'file') {
      const url = String(part.url || '');
      if (part.mime?.startsWith('image/') && (url.startsWith('data:image/') || url.startsWith('/api/sessions/'))) {
        const image = el('img', 'message-image'); image.src = url; image.alt = part.filename || 'Attached image'; card.append(image);
      } else if (part.filename) card.append(el('div', 'message-text', `Attached file: ${part.filename}`));
    } else if (part.type === 'tool') {
      const details = el('details', 'tool-chip');
      const summary = el('summary', '', `${part.tool || 'Tool'} · ${part.state?.status || 'activity'}${part.state?.title ? ` · ${part.state.title}` : ''}`);
      details.append(summary);
      const stateText = part.state?.output || part.state?.error || part.state?.raw || JSON.stringify(part.state?.input || {}, null, 2);
      if (stateText) details.append(el('pre', '', String(stateText).slice(0, 16000)));
      card.append(details);
    }
  }
  return card;
}

function isToolActivity(message) {
  return message.info?.role === 'assistant'
    && !textFromParts(message.parts).trim()
    && (message.parts || []).some((part) => ['tool', 'step-start', 'step-finish', 'reasoning'].includes(part.type));
}

function renderActivityGroup(group, agentStatus, isLatest) {
  const tools = group.flatMap((message) => (message.parts || []).filter((part) => part.type === 'tool'));
  const progressParts = group.flatMap((message) => (message.parts || []).filter((part) => ['reasoning', 'step-start', 'step-finish'].includes(part.type)));
  if (!tools.length && !progressParts.length) return null;
  const active = tools.some((part) => ['running', 'pending'].includes(part.state?.status)) || (isLatest && agentStatus === 'working');
  const details = el('details', 'activity-group');
  const summary = el('summary', 'activity-summary');
  const dot = el('span', `activity-dot${active ? ' is-active' : ''}`);
  const label = active
    ? (tools.length ? 'Working with tools' : 'Thinking…')
    : tools.length
      ? `Ran ${tools.length} ${tools.length === 1 ? 'action' : 'actions'}`
      : 'Completed a thinking step';
  summary.append(dot, el('span', '', label));
  const activityCount = tools.length || progressParts.length;
  if (activityCount > 0) summary.append(el('span', 'activity-count', String(activityCount)));
  details.append(summary);
  const list = el('div', 'activity-list');
  if (!tools.length) list.append(el('div', 'activity-note', active ? 'The agent is preparing its next response.' : 'Internal reasoning is hidden; this indicates progress only.'));
  for (const part of tools) {
    const item = el('details', 'activity-item');
    const stateLabel = part.state?.status || 'activity';
    const itemSummary = el('summary');
    itemSummary.append(el('span', 'activity-tool', part.tool || 'Tool'));
    itemSummary.append(el('span', 'activity-title', part.state?.title || stateLabel));
    itemSummary.append(el('span', `activity-state ${stateLabel}`, stateLabel));
    item.append(itemSummary);
    const output = part.state?.output || part.state?.error || part.state?.raw || JSON.stringify(part.state?.input || {}, null, 2);
    if (output) item.append(el('pre', '', String(output).slice(0, 16000)));
    list.append(item);
  }
  details.append(list);
  return details;
}

function renderChat() {
  if (state.view !== 'chat') return;
  main.replaceChildren();
  const view = el('section', 'chat-view');
  const session = state.selectedSession;
  if (!session && state.loadingSession) return renderLoading();
  if (!session) return main.append(el('div', 'error-card', 'Conversation could not be loaded. Return to History and try again.'));
  title.textContent = session.title || 'Conversation';
  const agent = state.overview?.agents?.find((item) => item.sessionId === session.id || item.paneId === state.selectedPaneId);
  const top = el('div', 'chat-top');
  const menuButton = button('', 'icon-button chat-sidebar-toggle', openSidebar, { 'aria-label': 'Open sidebar' });
  menuButton.append(icon('list'));
  top.append(menuButton);
  const backButton = button('', 'back-button', () => setView(state.previousView), { 'aria-label': 'Back to previous view' });
  backButton.append(icon('arrow-left'));
  top.append(backButton);
  const titleWrap = el('div', 'chat-title-wrap');
  titleWrap.append(el('h2', 'chat-title', session.title || 'Conversation'));
  titleWrap.append(el('div', 'chat-subtitle', `${session.directory?.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~') || '~/'}${agent ? ` · ${statusLabel(agent.status)}` : ' · Saved conversation'}`));
  top.append(titleWrap);
  if (agent?.status === 'working') top.append(button('Stop', 'small-button', () => interruptAgent(agent)));
  if (agent) top.append(button('Output', 'small-button', () => showOutput(agent)));
  view.append(top);

  if (agent?.status === 'blocked') {
    view.append(el('div', 'approval-note', 'This agent is waiting for approval. Review its live output before responding. Workbench will not approve actions automatically.'));
  }
  if (state.hasOlderMessages) {
    const older = button(state.loadingEarlier ? 'Loading older messages…' : 'Load earlier messages', 'button button-quiet load-earlier-messages', loadEarlierMessages);
    older.disabled = state.loadingEarlier;
    view.append(older);
  }
  const messages = el('div', 'message-list');
  messages.id = 'message-list';
  if (session.messages?.length) {
    const history = session.messages;
    for (let index = 0; index < history.length;) {
      const message = history[index];
      if (!isToolActivity(message)) {
        messages.append(renderMessage(message));
        index += 1;
        continue;
      }
      const group = [];
      while (index < history.length && isToolActivity(history[index])) group.push(history[index++]);
      const activity = renderActivityGroup(group, agent?.status, index === history.length);
      if (activity) messages.append(activity);
    }
  } else {
    messages.append(el('div', 'chat-empty', 'This conversation has no messages yet.'));
  }
  view.append(messages);

  if (agent && agent.status !== 'blocked') view.append(renderComposer(agent));
  else if (!agent) view.append(el('div', 'empty-card', 'This is saved history. Its live agent is no longer attached to a Herdr pane.'));
  main.append(view);
  requestAnimationFrame(() => {
    if (state.scrollToBottom) messages.scrollTop = messages.scrollHeight;
    state.scrollToBottom = false;
  });
}

function renderComposer(agent) {
  const sessionId = state.selectedSessionId || agent.sessionId || agent.paneId;
  const draft = composerDraft(sessionId);
  const form = el('form', 'composer');
  form.addEventListener('submit', (event) => { event.preventDefault(); sendPrompt(agent); });
  const textarea = el('textarea');
  textarea.placeholder = 'Message this agent…';
  textarea.value = draft.text;
  textarea.disabled = state.sending;
  textarea.setAttribute('aria-label', 'Message this agent');
  textarea.addEventListener('input', () => { draft.text = textarea.value; });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); sendPrompt(agent);
    }
  });
  textarea.addEventListener('paste', async (event) => {
    const clipboard = event.clipboardData;
    const images = [...(clipboard?.items || [])]
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!images.length) return;
    event.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const pastedText = clipboard.getData('text/plain');
    draft.text = `${textarea.value.slice(0, start)}${pastedText}${textarea.value.slice(end)}`;
    for (const image of images) await addAttachment(image, sessionId);
    if (state.view === 'chat' && state.selectedSessionId === sessionId) {
      renderChat();
      const next = $('#main-content .composer textarea');
      if (next) {
        next.focus();
        next.setSelectionRange(start + pastedText.length, start + pastedText.length);
      }
    }
  });
  form.append(textarea);

  const strip = el('div', 'attachment-strip');
  for (const [index, attachment] of draft.attachments.entries()) {
    const thumb = el('div', 'attachment-thumb');
    const image = el('img'); image.src = attachment.dataUrl; image.alt = attachment.name;
    const remove = button('', 'attachment-remove', () => { draft.attachments.splice(index, 1); renderChat(); }, { 'aria-label': 'Remove attachment' });
    remove.disabled = state.sending;
    remove.append(icon('x'));
    thumb.append(image, remove);
    strip.append(thumb);
  }
  if (draft.attachments.length) form.append(strip);

  const bottom = el('div', 'composer-bottom');
  const left = el('div', 'composer-left');
  const input = el('input', 'sr-only'); input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp,image/gif'; input.multiple = true; input.disabled = state.sending;
  input.addEventListener('change', async () => {
    for (const file of input.files || []) await addAttachment(file, sessionId);
    if (state.view === 'chat' && state.selectedSessionId === sessionId) renderChat();
    input.value = '';
  });
  const attach = button('', 'attach-button', () => input.click(), { 'aria-label': 'Attach an image' });
  attach.disabled = state.sending;
  attach.append(icon('paperclip'));
  left.append(input, attach);
  const paste = button('Paste', 'small-button', () => pasteIntoComposer(sessionId));
  paste.disabled = state.sending;
  paste.prepend(icon('clipboard-text'));
  left.append(paste);
  left.append(el('span', 'composer-hint', 'Paste an image or add a photo'));
  const right = el('div', 'composer-right');
  const send = el('button', 'send-button');
  send.append(document.createTextNode(state.sending ? 'Sending…' : 'Send'));
  if (!state.sending) send.append(icon('arrow-up-right'));
  send.type = 'submit'; send.disabled = state.sending;
  right.append(send);
  bottom.append(left, right);
  form.append(bottom);
  return form;
}

async function fileToDataUrl(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  let blob = file;
  const animatedType = ['image/gif', 'image/webp'].includes(file.type);
  const needsConversion = !supportedTypes.has(file.type) || (file.size > 900_000 && !animatedType);
  if (needsConversion && typeof createImageBitmap === 'function') {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser cannot convert the image.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const converted = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', .82));
      if (converted) blob = converted;
      else if (!supportedTypes.has(file.type)) throw new Error('This image format could not be converted.');
    } catch (error) {
      if (!supportedTypes.has(file.type)) throw new Error('This image format is not supported by this browser. Use JPEG, PNG, WebP or GIF.');
    } finally {
      bitmap?.close();
    }
  }
  if (!supportedTypes.has(blob?.type || file.type)) throw new Error('Use a JPEG, PNG, WebP or GIF image.');
  if (!blob || blob.size > 5 * 1024 * 1024) throw new Error('Image is too large. Try a smaller screenshot (max 5 MB).');
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.readAsDataURL(blob);
  });
}

async function addAttachment(file, sessionId = state.selectedSessionId) {
  const draft = composerDraft(sessionId);
  try {
    if (draft.attachments.length >= 4) throw new Error('Attach up to four images at a time.');
    const dataUrl = await fileToDataUrl(file);
    draft.attachments.push({ name: file.name || 'image', dataUrl });
  } catch (error) { toast(error.message, true); }
}

async function readSystemClipboard() {
  if (!window.isSecureContext) {
    throw new Error('System clipboard access requires HTTPS. Open Workbench at its Tailscale HTTPS address.');
  }
  if (!navigator.clipboard) throw new Error('This browser does not allow clipboard access. Use the device Paste command in the text field.');
  const result = { text: '', images: [] };
  if (navigator.clipboard.read) {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      let capturedImage = false;
      for (const type of item.types) {
        if (type.startsWith('image/') && !capturedImage) {
          const blob = await item.getType(type);
          const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[type] || 'image';
          result.images.push(new File([blob], `clipboard-${Date.now()}.${extension}`, { type }));
          capturedImage = true;
        }
        if (type === 'text/plain' && !result.text) result.text = await (await item.getType(type)).text();
      }
    }
    return result;
  }
  if (navigator.clipboard.readText) result.text = await navigator.clipboard.readText();
  else throw new Error('This browser does not allow clipboard access. Use the device Paste command in the text field.');
  return result;
}

async function pasteIntoComposer(sessionId = state.selectedSessionId) {
  const textarea = $('#main-content .composer textarea');
  if (!textarea || !sessionId) return;
  const draft = composerDraft(sessionId);
  try {
    const clipboard = await readSystemClipboard();
    if (clipboard.images.length + draft.attachments.length > 4) throw new Error('Attach up to four images at a time.');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (clipboard.text) {
      textarea.setRangeText(clipboard.text, start, end, 'end');
      draft.text = textarea.value;
    }
    for (const image of clipboard.images) await addAttachment(image, sessionId);
    if (clipboard.images.length) {
      if (state.view === 'chat' && state.selectedSessionId === sessionId) {
        renderChat();
        const next = $('#main-content .composer textarea');
        if (next) {
          next.focus();
          next.setSelectionRange(start + clipboard.text.length, start + clipboard.text.length);
        }
      }
    }
  } catch (error) { toast(error.message || 'Clipboard access was not granted.', true); }
}

async function sendPrompt(agent) {
  if (state.sending) return;
  const sessionId = state.selectedSessionId;
  const draft = composerDraft(sessionId);
  const text = draft.text;
  const attachments = draft.attachments.slice();
  if (!text.trim() && !attachments.length) return;
  state.sending = true;
  renderChat();
  try {
    await api(`/api/agents/${encodeURIComponent(agent.paneId)}/prompt`, {
      method: 'POST',
      body: { text, images: attachments.map((item) => ({ name: item.name, dataUrl: item.dataUrl })) },
    });
    draft.text = '';
    draft.attachments = [];
    toast('Sent to your agent');
    await refreshSession(sessionId);
  } catch (error) { toast(error.message, true); }
  finally {
    state.sending = false;
    if (state.view === 'chat') renderChat();
  }
}

async function interruptAgent(agent) {
  try {
    await api(`/api/agents/${encodeURIComponent(agent.paneId)}/interrupt`, { method: 'POST', body: {} });
    toast('Interrupt sent');
    await refreshOverview();
  } catch (error) { toast(error.message, true); }
}

async function showOutput(agent) {
  const root = $('#modal-root');
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('section', 'modal');
  const head = el('div', 'modal-head');
  const copy = el('div'); copy.append(el('h2', '', 'Live agent output'), el('p', '', `${agent.sessionTitle || agent.title} · ${agent.paneId}`));
  const actions = el('div', 'chat-tools');
  actions.append(button('Copy output', 'small-button', async () => {
    const text = modal.querySelector('.terminal-output')?.textContent || '';
    if (!text) return;
    try { await copyText(text); toast('Output copied'); } catch (error) { toast(error.message, true); }
  }));
  const closeButton = button('', 'modal-close', () => root.replaceChildren(), { 'aria-label': 'Close' });
  closeButton.append(icon('x'));
  actions.append(closeButton);
  head.append(copy, actions);
  modal.append(head, el('div', 'loading-card', 'Reading recent output…'));
  backdrop.append(modal); root.replaceChildren(backdrop);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) root.replaceChildren(); });
  try {
    const data = await api(`/api/agents/${encodeURIComponent(agent.paneId)}/output`);
    const pre = el('pre', 'terminal-output');
    pre.textContent = data.output || 'No recent output.';
    modal.lastChild.replaceWith(pre);
  } catch (error) { modal.lastChild.replaceWith(el('div', 'error-card', error.message)); }
}

async function loadEarlierMessages() {
  const sessionId = state.selectedSessionId;
  if (!sessionId || state.view !== 'chat' || state.loadingEarlier || !state.hasOlderMessages) return;
  const cursor = state.olderMessages[0]?.id || state.latestMessages[0]?.id;
  if (!cursor) return;
  const listBefore = $('#message-list');
  const oldHeight = listBefore?.scrollHeight || 0;
  const oldTop = listBefore?.scrollTop || 0;
  state.loadingEarlier = true;
  const buttonBefore = $('.load-earlier-messages');
  if (buttonBefore) { buttonBefore.disabled = true; buttonBefore.textContent = 'Loading older messages…'; }
  let loaded = false;
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(sessionId)}?before=${encodeURIComponent(cursor)}`);
    if (state.view !== 'chat' || state.selectedSessionId !== sessionId) return;
    const older = payload.session.messages || [];
    state.olderMessages = [...older, ...state.olderMessages];
    state.messageTotal = Number(payload.session.messageTotal || state.messageTotal);
    state.hasOlderMessages = Boolean(payload.session.hasMoreMessages);
    state.selectedSession = {
      ...state.selectedSession,
      ...payload.session,
      messages: [...state.olderMessages, ...state.latestMessages],
      messageTotal: state.messageTotal,
      hasMoreMessages: state.hasOlderMessages,
    };
    loaded = true;
  } catch (error) {
    if (state.selectedSessionId === sessionId) toast(error.message, true);
  } finally {
    if (state.view === 'chat' && state.selectedSessionId === sessionId) {
      state.loadingEarlier = false;
      if (loaded) {
        renderChat();
        requestAnimationFrame(() => {
          const list = $('#message-list');
          if (list) list.scrollTop = oldTop + list.scrollHeight - oldHeight;
        });
      } else {
        const currentButton = $('.load-earlier-messages');
        if (currentButton) {
          currentButton.disabled = false;
          currentButton.textContent = 'Load earlier messages';
        }
      }
    }
  }
}

async function refreshSession(sessionId = state.selectedSessionId) {
  if (!sessionId || state.selectedSessionId !== sessionId || state.view !== 'chat') return;
  if (state.loadingEarlier) return;
  const requestId = ++state.sessionRefreshRequestId;
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(sessionId)}?offset=0`);
    if (requestId !== state.sessionRefreshRequestId || state.selectedSessionId !== sessionId || state.view !== 'chat' || state.loadingEarlier) return;
    const previousLatest = state.latestMessages;
    const oldLast = previousLatest.at(-1);
    const newLast = payload.session.messages?.at(-1);
    const messageTotal = Number(payload.session.messageTotal || 0);
    if (state.selectedSession?.updated === payload.session.updated
      && oldLast?.id === newLast?.id
      && oldLast?.parts?.length === newLast?.parts?.length
      && state.messageTotal === messageTotal) return;
    const textarea = $('#main-content .composer textarea');
    const restoreComposer = textarea && textarea === document.activeElement;
    const selectionStart = restoreComposer ? textarea.selectionStart : 0;
    const selectionEnd = restoreComposer ? textarea.selectionEnd : 0;
    const oldList = $('#message-list');
    const wasNearBottom = !oldList || oldList.scrollHeight - oldList.scrollTop < oldList.clientHeight + 180;
    const latestMessages = payload.session.messages || [];
    const latestIds = new Set(latestMessages.map((message) => message.id));
    const olderIds = new Set(state.olderMessages.map((message) => message.id));
    const displaced = previousLatest.filter((message) => !latestIds.has(message.id) && !olderIds.has(message.id));
    state.olderMessages = [...state.olderMessages, ...displaced];
    state.latestMessages = latestMessages;
    state.messageTotal = messageTotal;
    state.hasOlderMessages = state.olderMessages.length + state.latestMessages.length < state.messageTotal;
    state.selectedSession = {
      ...payload.session,
      messages: [...state.olderMessages, ...state.latestMessages],
      messageTotal: state.messageTotal,
      hasMoreMessages: state.hasOlderMessages,
    };
    state.scrollToBottom = wasNearBottom;
    renderChat();
    requestAnimationFrame(() => {
      if (!wasNearBottom) {
        const list = $('#message-list');
        if (list) list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - 100);
      }
      if (restoreComposer && state.selectedSessionId === sessionId) {
        const next = $('#main-content .composer textarea');
        if (next) {
          next.focus({ preventScroll: true });
          next.setSelectionRange(selectionStart, selectionEnd);
        }
      }
    });
  } catch {}
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.className = 'clipboard-fallback';
  area.readOnly = true;
  document.body.append(area);
  area.focus(); area.select(); area.setSelectionRange(0, area.value.length);
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Copy was blocked. Open Workbench over Tailscale HTTPS and allow clipboard access.');
}

function renderClips() {
  main.replaceChildren();
  const view = el('div', 'clips-view');
  view.append(sectionHead('Clipboard', 'Move text and images between your devices. Clips are stored privately on this VPS.'));
  if (!window.isSecureContext) {
    view.append(el('div', 'clipboard-warning', 'Native clipboard access is disabled on this connection. Use the Tailscale HTTPS address for one-tap copy, paste, and image transfer.'));
  }
  const form = el('form', 'clip-compose');
  const textarea = el('textarea'); textarea.placeholder = 'Paste text here to move it to another device…'; textarea.value = state.clipDraft; textarea.setAttribute('aria-label', 'Text to save in the clip tray');
  textarea.addEventListener('input', () => { state.clipDraft = textarea.value; });
  textarea.addEventListener('paste', async (event) => {
    const image = [...(event.clipboardData?.items || [])].find((item) => item.type.startsWith('image/'))?.getAsFile();
    if (!image) return;
    event.preventDefault();
    try {
      const pastedText = event.clipboardData?.getData('text/plain') || '';
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      if (pastedText) {
        textarea.setRangeText(pastedText, start, end, 'end');
        state.clipDraft = textarea.value;
      }
      const dataUrl = await fileToDataUrl(image);
      await api('/api/clips', { method: 'POST', body: { kind: 'image', dataUrl, device: deviceName() } });
      await loadClips();
      const next = $('#main-content .clip-compose textarea');
      if (next) { next.value = state.clipDraft; next.focus(); }
      toast('Image saved for your other devices');
    } catch (error) { toast(error.message, true); }
  });
  form.append(textarea);
  const actions = el('div', 'clip-compose-actions');
  const imageInput = el('input', 'sr-only'); imageInput.type = 'file'; imageInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
  actions.append(imageInput);
  actions.append(button('Paste from clipboard', 'button button-quiet', async () => {
    try {
      const clipboard = await readSystemClipboard();
      const textToKeep = clipboard.text || textarea.value;
      state.clipDraft = textToKeep;
      for (const image of clipboard.images) {
        const dataUrl = await fileToDataUrl(image);
        await api('/api/clips', { method: 'POST', body: { kind: 'image', dataUrl, device: deviceName() } });
      }
      if (clipboard.images.length) await loadClips();
      const current = $('#main-content .clip-compose textarea');
      if (current) { current.value = textToKeep; current.focus(); }
      if (clipboard.images.length) toast('Image saved for your other devices');
      else if (!clipboard.text) toast('The clipboard is empty.', true);
    } catch (error) { toast(error.message || 'Clipboard permission was not granted.', true); }
  }));
  actions.append(button('Add image', 'button button-quiet', () => imageInput.click()));
  actions.append(button('Save text', 'button button-primary', () => form.requestSubmit()));
  form.append(actions);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = textarea.value;
    if (!text.trim()) return toast('Paste or type text first.', true);
    if (text.length > 50_000) return toast('Clipboard text must be 50,000 characters or fewer.', true);
    try {
      await api('/api/clips', { method: 'POST', body: { kind: 'text', text, device: deviceName() } });
      state.clipDraft = '';
      textarea.value = '';
      await loadClips();
      toast('Saved for your other devices');
    } catch (error) { toast(error.message, true); }
  });
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0]; if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      await api('/api/clips', { method: 'POST', body: { kind: 'image', dataUrl, device: deviceName() } });
      await loadClips(); toast('Image saved for your other devices');
    } catch (error) { toast(error.message, true); }
    finally { imageInput.value = ''; }
  });
  view.append(form);
  const grid = el('div', 'clip-grid');
  if (!state.clips.length) {
    const empty = el('div', 'clip-empty'); empty.textContent = 'Nothing saved yet. Paste or add something above, then pick it up on another device.'; view.append(empty);
  } else {
    for (const clip of state.clips) grid.append(renderClip(clip));
    view.append(grid);
  }
  main.append(view);
}

function renderClip(clip) {
  const card = el('article', 'clip-card');
  if (clip.kind === 'image') {
    const image = el('img'); image.src = `/api/clips/${encodeURIComponent(clip.id)}/data`; image.alt = 'Shared image clip'; card.append(image);
  } else card.append(el('div', 'clip-text', clip.text));
  const meta = el('div', 'clip-meta'); meta.append(el('span', '', clip.device || 'Device')); meta.append(el('time', '', formatTime(clip.created, true))); card.append(meta);
  const actions = el('div', 'clip-actions');
  if (clip.kind === 'image') {
    actions.append(button('Copy image', 'small-button', async () => {
      try {
        if (!window.isSecureContext || !navigator.clipboard?.write || !window.ClipboardItem) throw new Error('Image copying requires Workbench over Tailscale HTTPS.');
        const png = clipImageAsPng(clip.id);
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        } catch {
          const blob = await png;
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        }
        toast('Image copied to this device');
      } catch (error) { toast(error.message, true); }
    }));
    actions.append(button('Open', 'small-button', () => window.open(`/api/clips/${encodeURIComponent(clip.id)}/data`, '_blank', 'noopener')));
  } else actions.append(button('Copy text', 'small-button', async () => {
    try { await copyText(clip.text); toast('Copied to this device'); }
    catch (error) { toast(error.message, true); }
  }));
  actions.append(button('Delete', 'small-button', async () => {
    try { await api(`/api/clips/${encodeURIComponent(clip.id)}`, { method: 'DELETE' }); await loadClips(); toast('Clip deleted'); }
    catch (error) { toast(error.message, true); }
  }));
  card.append(actions);
  return card;
}

async function clipImageAsPng(id) {
  const response = await fetch(`/api/clips/${encodeURIComponent(id)}/data`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load this image clip.');
  const blob = await response.blob();
  if (blob.type === 'image/png') return blob;
  if (typeof createImageBitmap !== 'function') throw new Error('This browser cannot convert this image for clipboard copy.');
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not prepare image for clipboard copy.')), 'image/png'));
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'PC';
  if (/Android/i.test(ua)) return 'Android';
  return 'This device';
}

function renderLoading() {
  main.replaceChildren();
  const card = el('div', 'loading-card'); card.append(el('span', 'loader'), el('span', '', 'Opening your workspace…'));
  main.append(card);
}

function render() {
  updateNavCounts();
  if (state.view === 'now') renderNow();
  else if (state.view === 'history') renderHistory();
  else if (state.view === 'clips') renderClips();
  else if (state.view === 'chat') renderChat();
}

async function refreshOverview() {
  const requestId = ++state.overviewRequestId;
  try {
    const overview = await api('/api/overview');
    if (requestId !== state.overviewRequestId) return;
    state.overview = overview;
    setConnection(true);
    updateNavCounts();
    renderSidebar();
    if (state.view === 'now') render();
    else if (state.view === 'history' && document.activeElement?.type !== 'search') render();
  } catch (error) {
    if (requestId !== state.overviewRequestId) return;
    setConnection(false);
    if (!state.overview) {
      main.replaceChildren(el('div', 'error-card', `${error.message} The local console is up; live agent details may be unavailable.`));
    }
  }
}

async function loadClips() {
  const requestId = ++state.clipsRequestId;
  try {
    const clips = (await api('/api/clips')).clips || [];
    if (requestId !== state.clipsRequestId) return;
    const changed = clips.length !== state.clips.length || clips.some((clip, index) => clip.id !== state.clips[index]?.id);
    state.clips = clips;
    if (state.view === 'clips' && changed) {
      const textarea = $('.clip-compose textarea', main);
      const restoreFocus = textarea && document.activeElement === textarea;
      const selectionStart = restoreFocus ? textarea.selectionStart : 0;
      const selectionEnd = restoreFocus ? textarea.selectionEnd : 0;
      renderClips();
      if (restoreFocus) {
        const next = $('.clip-compose textarea', main);
        if (next) {
          next.focus({ preventScroll: true });
          next.setSelectionRange(selectionStart, selectionEnd);
        }
      }
    }
  } catch (error) {
    if (requestId === state.clipsRequestId) toast(error.message, true);
  }
}

async function showNewTask() {
  closeSidebar();
  const root = $('#modal-root');
  const modal = el('section', 'modal');
  const backdrop = el('div', 'modal-backdrop');
  const head = el('div', 'modal-head');
  const heading = el('div'); heading.append(el('h2', '', 'Start a task'), el('p', '', 'Give your agent a project and a clear first instruction.'));
  const close = button('', 'modal-close', () => root.replaceChildren(), { 'aria-label': 'Close' });
  close.append(icon('x'));
  head.append(heading, close); modal.append(head);
  const form = el('form');
  const memoryFree = Number(state.overview?.system?.memoryFree || 0);
  const memoryOkay = memoryFree >= 1024 * 1024 * 1024;
  if (!memoryOkay) form.append(el('div', 'memory-warning', `The VPS has ${humanBytes(memoryFree)} available. Finish or close a task before starting another so the server stays responsive.`));
  const dirs = state.overview?.directories || [];
  const dirField = el('div', 'field'); dirField.append(el('label', '', 'Project'));
  const select = el('select'); select.name = 'directory';
  for (const item of dirs) { const option = el('option', '', item.name); option.value = item.directory; select.append(option); }
  dirField.append(select); form.append(dirField);
  const agentField = el('div', 'field'); agentField.append(el('label', '', 'Agent'));
  const kind = el('select');
  for (const [value, labelText] of [['opencode', 'OpenCode'], ['pi', 'Pi']]) { const option = el('option', '', labelText); option.value = value; kind.append(option); }
  agentField.append(kind); form.append(agentField);
  const titleField = el('div', 'field'); titleField.append(el('label', '', 'Task name (optional)'));
  const titleInput = el('input'); titleInput.placeholder = 'What are we working on?'; titleField.append(titleInput); form.append(titleField);
  const promptField = el('div', 'field'); promptField.append(el('label', '', 'First instruction'));
  const promptInput = el('textarea'); promptInput.placeholder = 'Describe the outcome you want…'; promptField.append(promptInput); form.append(promptField);
  const footer = el('div', 'modal-footer');
  footer.append(button('Cancel', 'button button-quiet', () => root.replaceChildren()));
  const start = el('button', 'button button-primary', 'Start task'); start.type = 'submit'; start.disabled = !memoryOkay; footer.append(start);
  form.append(footer);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!promptInput.value.trim()) return toast('Add the first instruction.', true);
    start.disabled = true; start.textContent = 'Starting…';
    try {
      const result = await api('/api/tasks', { method: 'POST', body: { directory: select.value, kind: kind.value, title: titleInput.value, prompt: promptInput.value } });
      root.replaceChildren();
      if (result.promptSubmitted === false) toast(result.warning || 'The agent started, but its first message was not confirmed.', true);
      else toast(`Started ${result.kind} in ${result.paneId}`);
      await refreshOverview();
    } catch (error) { toast(error.message, true); start.disabled = !memoryOkay; start.textContent = 'Start task'; }
  });
  modal.append(form); backdrop.append(modal); backdrop.addEventListener('click', (event) => { if (event.target === backdrop) root.replaceChildren(); });
  root.replaceChildren(backdrop);
  setTimeout(() => promptInput.focus(), 80);
}

document.querySelectorAll('[data-view]').forEach((node) => node.addEventListener('click', () => setView(node.dataset.view)));
$('#new-task').addEventListener('click', showNewTask);
$('#new-task-top').addEventListener('click', showNewTask);
$('#sidebar-toggle').addEventListener('click', openSidebar);
$('#sidebar-close').addEventListener('click', closeSidebar);
$('#sidebar-scrim').addEventListener('click', closeSidebar);
$('#search-history').addEventListener('click', () => {
  setView('history');
  requestAnimationFrame(() => $('.search-box input')?.focus());
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && appShell.classList.contains('sidebar-open')) closeSidebar();
});

await refreshOverview();
setInterval(refreshOverview, 10_000);
setInterval(() => { if (state.view === 'chat') refreshSession(); }, 3_500);
setInterval(() => { if (state.view === 'clips') loadClips(); }, 15_000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

window.addEventListener('hashchange', () => {
  const view = location.hash.replace('#', '');
  if (['now', 'history', 'clips'].includes(view)) setView(view);
});
if (location.hash === '#history') setView('history');
if (location.hash === '#clips') { setView('clips'); loadClips(); }
