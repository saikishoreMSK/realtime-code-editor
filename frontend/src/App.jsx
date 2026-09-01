import './App.css'
import io from 'socket.io-client';
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import * as Y from 'yjs';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { MonacoBinding } from 'y-monaco';
import GitHubPanel from './components/GitHubPanel';
import FilesPanel from './components/FilesPanel';
import { languageForPath } from './github';
import { buildTree } from './tree';

const socket = io();

const CURSOR_COLORS = [
  '#f97316', '#22c55e', '#3b82f6', '#e11d48',
  '#a855f7', '#14b8a6', '#eab308', '#ec4899',
];

// Derive the colour from the name so a user keeps the same one across reconnects.
const colorFor = (name) => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
};

const TYPING_THROTTLE_MS = 1000;

// Paths come from a text box, so they are normalised before becoming CRDT keys.
const normalizePath = (raw) => String(raw ?? '')
  .trim()
  .replace(/\\/g, '/')
  .replace(/\/{2,}/g, '/')
  .replace(/^\/+|\/+$/g, '');

const assertUsable = (candidate) => {
  if (!candidate) throw new Error('Enter a name.');
  if (candidate.split('/').includes('..')) throw new Error('Paths cannot contain "..".');
  if (candidate.length > 200) throw new Error('That path is too long.');
};

const parentOf = (candidate) => (
  candidate.includes('/') ? candidate.slice(0, candidate.lastIndexOf('/')) : ''
);

const App = () => {
  const [joined, setJoined] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [userName, setUserName] = useState("");
  const [roomPassword, setRoomPassword] = useState("");
  const [joinError, setJoinError] = useState("");
  const [users, setUsers] = useState([]);
  const [typing, setTyping] = useState("");
  const [copySuccess, setCopySuccess] = useState("");
  const [userInput, setUserInput] = useState("");
  const [outPut, setOutPut] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  // The editor must not bind until the server's document has arrived, or it would
  // bind to a locally created Y.Text that the real one then orphans.
  const [synced, setSynced] = useState(false);
  const [connected, setConnected] = useState(socket.connected);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [consoleOpen, setConsoleOpen] = useState(true);

  // Every path in the room, mirrored out of the CRDT for rendering.
  const [filePaths, setFilePaths] = useState([]);
  // Which file *this* user is looking at. Deliberately not in the CRDT — sharing
  // it would drag everyone onto the same file and defeat the point.
  const [activePath, setActivePath] = useState("");
  const [editorReady, setEditorReady] = useState(false);
  // Folders are implied by file paths; these are the ones that hold nothing yet.
  const [folderPaths, setFolderPaths] = useState([]);
  // path -> everyone else currently looking at it, from awareness.
  const [viewers, setViewers] = useState({});

  // The CRDT document is rebuilt per room — reusing one across rooms would merge
  // the previous room's content into the new one.
  const docRef = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const bindingRef = useRef(null);
  const modelsRef = useRef({});
  const typingAtRef = useRef(0);
  // Editor callbacks are registered once on mount, so they read identity from refs.
  const roomIdRef = useRef("");
  const userNameRef = useRef("");
  // Kept so a reconnect can re-join; without it the tab silently leaves the room.
  const joinParamsRef = useRef(null);

  const teardown = useCallback(() => {
    bindingRef.current?.destroy();
    bindingRef.current = null;

    Object.values(modelsRef.current).forEach((model) => {
      if (!model.isDisposed()) model.dispose();
    });
    modelsRef.current = {};

    if (docRef.current) {
      docRef.current.awareness.destroy();
      docRef.current.ydoc.destroy();
      docRef.current = null;
    }
  }, []);

  const createDoc = useCallback((name) => {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    awareness.setLocalStateField('user', { name, color: colorFor(name) });

    // Local edits are forwarded to the server. Updates arriving from the server are
    // applied with origin 'remote' so they are not echoed straight back.
    ydoc.on('update', (update, origin) => {
      if (origin !== 'remote') socket.emit('yUpdate', update);
    });

    awareness.on('update', ({ added, updated, removed }) => {
      const changed = added.concat(updated, removed);
      socket.emit('awareness', encodeAwarenessUpdate(awareness, changed));
    });

    // Mirror the file list into React state. The map is empty until ySync lands,
    // so this fires again once the server's document arrives.
    const files = ydoc.getMap('files');
    const readPaths = () => setFilePaths([...files.keys()].sort());
    files.observe(readPaths);
    readPaths();

    const folders = ydoc.getMap('folders');
    const readFolders = () => setFolderPaths([...folders.keys()].sort());
    folders.observe(readFolders);
    readFolders();

    docRef.current = { ydoc, awareness };
    return docRef.current;
  }, []);

  // Point the editor at the Y.Text for one file.
  const bindPath = useCallback((filePath) => {
    const doc = docRef.current;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!doc || !editor || !monaco) return;

    // A stale binding would keep writing edits into the previously bound file.
    bindingRef.current?.destroy();
    bindingRef.current = null;

    // Never create the Y.Text here: it would race the server's seed and leave this
    // editor bound to a document the real one then orphans.
    const ytext = doc.ydoc.getMap('files').get(filePath);
    if (!ytext) return;

    let model = modelsRef.current[filePath];
    if (!model || model.isDisposed()) {
      // Start empty and let the binding fill it, so content is never inserted twice.
      model = monaco.editor.createModel('', languageForPath(filePath) || 'plaintext');
      modelsRef.current[filePath] = model;
    }
    editor.setModel(model);

    // y-monaco encodes remote cursors as Yjs relative positions, which carry the
    // type they belong to, so cursors belonging to other files are ignored here.
    bindingRef.current = new MonacoBinding(ytext, model, new Set([editor]), doc.awareness);
  }, []);

  useEffect(() => {
    const applyToDoc = (update) => {
      const doc = docRef.current;
      if (doc) Y.applyUpdate(doc.ydoc, new Uint8Array(update), 'remote');
    };

    const onSync = (update) => {
      const doc = docRef.current;
      if (!doc) return;
      Y.applyUpdate(doc.ydoc, new Uint8Array(update), 'remote');
      // Hand our own state back, so edits made while disconnected aren't lost and
      // the server converges with us rather than only us with it.
      socket.emit('yUpdate', Y.encodeStateAsUpdate(doc.ydoc));
      setSynced(true);
    };

    // Socket.IO re-fires 'connect' after a reconnect. Re-joining is what puts this
    // socket back in the room; otherwise it can still send but receives nothing.
    const onConnect = () => {
      setConnected(true);
      const params = joinParamsRef.current;
      const doc = docRef.current;
      if (params && doc) {
        socket.emit('join', { ...params, clientId: doc.awareness.clientID });
      }
    };

    const onDisconnect = () => {
      setConnected(false);
      setSynced(false);
    };

    const onAwareness = (update) => {
      const doc = docRef.current;
      if (doc) applyAwarenessUpdate(doc.awareness, new Uint8Array(update), 'remote');
    };

    // A client that drops can't announce its own departure, so the server tells us.
    const onAwarenessLeave = (clientId) => {
      const doc = docRef.current;
      if (doc) removeAwarenessStates(doc.awareness, [clientId], 'remote');
    };

    const onJoinError = (msg) => {
      setJoinError(msg);
      setJoined(false);
      joinParamsRef.current = null;
      teardown();
    };

    const onTyping = (user) => {
      setTyping(`${user} is typing…`);
      setTimeout(() => setTyping(""), 2000);
    };

    const onCodeResponse = (response) => {
      setOutPut(response.run.output);
      setIsExecuting(false);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('ySync', onSync);
    socket.on('yUpdate', applyToDoc);
    socket.on('awareness', onAwareness);
    socket.on('awarenessLeave', onAwarenessLeave);
    socket.on('userJoined', setUsers);
    socket.on('joinError', onJoinError);
    socket.on('userTyping', onTyping);
    socket.on('codeResponse', onCodeResponse);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('ySync', onSync);
      socket.off('yUpdate', applyToDoc);
      socket.off('awareness', onAwareness);
      socket.off('awarenessLeave', onAwarenessLeave);
      socket.off('userJoined', setUsers);
      socket.off('joinError', onJoinError);
      socket.off('userTyping', onTyping);
      socket.off('codeResponse', onCodeResponse);
    };
  }, [teardown]);

  // Land on a real file, and move off one that someone else has deleted.
  useEffect(() => {
    if (!synced || filePaths.length === 0) return;
    if (!activePath || !filePaths.includes(activePath)) setActivePath(filePaths[0]);
  }, [synced, filePaths, activePath]);

  useEffect(() => {
    if (joined && synced && editorReady && activePath) bindPath(activePath);
  }, [joined, synced, editorReady, activePath, bindPath]);

  // Tell the room which file we're in, so the tree can show who is where.
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || !joined || !synced) return;

    const user = doc.awareness.getLocalState()?.user;
    if (!user) return;
    doc.awareness.setLocalStateField('user', { ...user, path: activePath });
  }, [joined, synced, activePath]);

  useEffect(() => {
    if (!joined) return;
    const doc = docRef.current;
    if (!doc) return;

    const readViewers = () => {
      const byPath = {};
      doc.awareness.getStates().forEach((state, clientId) => {
        // Only other people count — a badge on your own file says nothing.
        if (clientId === doc.awareness.clientID) return;
        const user = state.user;
        if (!user?.path) return;

        if (!byPath[user.path]) byPath[user.path] = [];
        byPath[user.path].push({ name: user.name, color: user.color });
      });
      setViewers(byPath);
    };

    readViewers();
    doc.awareness.on('change', readViewers);
    return () => doc.awareness.off('change', readViewers);
  }, [joined]);

  // Monaco models are not garbage collected, so deleted files must be disposed.
  // The bound model is left alone; it is released on the render after activePath
  // has moved somewhere valid.
  useEffect(() => {
    const known = new Set(filePaths);
    Object.entries(modelsRef.current).forEach(([filePath, model]) => {
      if (known.has(filePath) || filePath === activePath) return;
      if (!model.isDisposed()) model.dispose();
      delete modelsRef.current[filePath];
    });
  }, [filePaths, activePath]);

  // y-monaco renders remote cursors via per-client CSS classes, so the colours and
  // name labels have to be injected as real stylesheet rules.
  useEffect(() => {
    if (!joined) return;
    const doc = docRef.current;
    if (!doc) return;

    const styleEl = document.createElement('style');
    document.head.appendChild(styleEl);

    const paint = () => {
      const rules = [];
      doc.awareness.getStates().forEach((state, clientId) => {
        if (clientId === doc.awareness.clientID) return;
        const user = state.user;
        if (!user) return;

        const label = String(user.name).replace(/["\\]/g, '');
        rules.push(
          `.yRemoteSelection-${clientId} { background-color: ${user.color}44; }`,
          `.yRemoteSelectionHead-${clientId} { border-left: 2px solid ${user.color}; }`,
          `.yRemoteSelectionHead-${clientId}::after {
             content: "${label}";
             background-color: ${user.color};
           }`
        );
      });
      styleEl.textContent = rules.join('\n');
    };

    paint();
    doc.awareness.on('change', paint);

    return () => {
      doc.awareness.off('change', paint);
      styleEl.remove();
    };
  }, [joined]);

  useEffect(() => {
    const handleBeforeUnload = () => socket.emit("leaveRoom");
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const joinRoom = () => {
    if (!roomId || !userName) return;

    setJoinError("");
    setSynced(false);
    setFilePaths([]);
    setFolderPaths([]);
    setActivePath("");
    setViewers({});
    teardown();
    const { awareness } = createDoc(userName);
    roomIdRef.current = roomId;
    userNameRef.current = userName;
    joinParamsRef.current = { roomId, userName, password: roomPassword };

    // The server needs our CRDT client id to clean up our cursor if we drop.
    socket.emit("join", { roomId, userName, password: roomPassword, clientId: awareness.clientID });
    setJoined(true);
  };

  const leaveRoom = () => {
    socket.emit("leaveRoom");
    joinParamsRef.current = null;
    teardown();
    setJoined(false);
    setSynced(false);
    setRoomId("");
    setUserName("");
    setRoomPassword("");
    setUsers([]);
    setTyping("");
    setOutPut("");
    setFilePaths([]);
    setFolderPaths([]);
    setActivePath("");
    setViewers({});
    setEditorReady(false);
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    setCopySuccess("Copied");
    setTimeout(() => setCopySuccess(""), 2000);
  };

  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    editor.onDidChangeModelContent(() => {
      // The binding also writes remote edits into the model; only report our own.
      if (!editor.hasTextFocus()) return;

      const now = Date.now();
      if (now - typingAtRef.current < TYPING_THROTTLE_MS) return;
      typingAtRef.current = now;

      socket.emit("typing", { roomId: roomIdRef.current, userName: userNameRef.current });
    });

    // Binding is driven by an effect: mount order and sync order both vary, and a
    // flag lets whichever finishes last trigger the bind.
    setEditorReady(true);
  };

  // Replace the active document in one transaction, so the room receives a single
  // CRDT update rather than a burst, and every participant sees the imported file.
  const importIntoEditor = useCallback(({ path: filePath, text }) => {
    const doc = docRef.current;
    if (!doc || !filePath) return;

    doc.ydoc.transact(() => {
      const files = doc.ydoc.getMap('files');
      if (!files.has(filePath)) files.set(filePath, new Y.Text());

      const ytext = files.get(filePath);
      ytext.delete(0, ytext.length);
      ytext.insert(0, text);
    });
    setActivePath(filePath);
  }, []);

  // Read from the CRDT rather than React state, so a commit always reflects what
  // the room currently holds.
  const readCode = useCallback(() => {
    const doc = docRef.current;
    if (!doc || !activePath) return '';
    return doc.ydoc.getMap('files').get(activePath)?.toString() ?? '';
  }, [activePath]);

  // A bulk import writes every file in one transaction, so the room receives a
  // single CRDT update rather than one per file.
  const importManyIntoEditor = useCallback((incoming) => {
    const doc = docRef.current;
    if (!doc || !incoming?.length) return;

    doc.ydoc.transact(() => {
      const files = doc.ydoc.getMap('files');
      const folders = doc.ydoc.getMap('folders');

      for (const { path: filePath, text } of incoming) {
        if (!files.has(filePath)) files.set(filePath, new Y.Text());

        const ytext = files.get(filePath);
        ytext.delete(0, ytext.length);
        ytext.insert(0, text);

        // The folder is implied by the path now, so its placeholder is redundant.
        const parent = parentOf(filePath);
        if (parent) folders.delete(parent);
      }
    });
    setActivePath(incoming[0].path);
  }, []);

  const createFile = useCallback((raw) => {
    const doc = docRef.current;
    if (!doc) throw new Error('Not connected to the room yet.');

    const filePath = normalizePath(raw);
    assertUsable(filePath);

    const files = doc.ydoc.getMap('files');
    if (files.has(filePath)) throw new Error(`${filePath} already exists.`);

    doc.ydoc.transact(() => {
      files.set(filePath, new Y.Text());
      // The folder is implied by the path now, so its placeholder is redundant.
      const parent = parentOf(filePath);
      if (parent) doc.ydoc.getMap('folders').delete(parent);
    });
    setActivePath(filePath);
  }, []);

  const createFolder = useCallback((raw) => {
    const doc = docRef.current;
    if (!doc) throw new Error('Not connected to the room yet.');

    const dirPath = normalizePath(raw);
    assertUsable(dirPath);

    const folders = doc.ydoc.getMap('folders');
    const implied = [...doc.ydoc.getMap('files').keys()]
      .some((filePath) => filePath.startsWith(`${dirPath}/`));
    if (implied || folders.has(dirPath)) throw new Error(`${dirPath} already exists.`);

    // Only empty folders are recorded. Once a file lives inside one, the path
    // implies it — the same way git declines to track empty directories.
    folders.set(dirPath, true);
  }, []);

  const renameFile = useCallback((from, raw) => {
    const doc = docRef.current;
    if (!doc) throw new Error('Not connected to the room yet.');

    const to = normalizePath(raw);
    assertUsable(to);
    if (to === from) return;

    const files = doc.ydoc.getMap('files');
    if (!files.has(from)) throw new Error(`${from} no longer exists.`);
    if (files.has(to)) throw new Error(`${to} already exists.`);

    // Yjs cannot move a type between keys, so the text is copied. Two people
    // renaming the same file at the same instant would therefore end up with two.
    const body = files.get(from).toString();
    doc.ydoc.transact(() => {
      files.set(to, new Y.Text());
      files.get(to).insert(0, body);
      files.delete(from);

      const parent = parentOf(to);
      if (parent) doc.ydoc.getMap('folders').delete(parent);
    });
    setActivePath(to);
  }, []);

  const deleteFile = useCallback((filePath) => {
    const doc = docRef.current;
    if (!doc) throw new Error('Not connected to the room yet.');

    const files = doc.ydoc.getMap('files');
    if (!files.has(filePath)) throw new Error(`${filePath} no longer exists.`);
    // An empty room would leave every editor with nothing to bind to.
    if (files.size <= 1) throw new Error('A room needs at least one file.');

    doc.ydoc.transact(() => {
      files.delete(filePath);

      // Removing the last file in a folder would make the folder vanish too, so
      // it becomes an explicit empty one instead.
      const parent = parentOf(filePath);
      const stillUsed = [...files.keys()]
        .some((other) => other.startsWith(`${parent}/`));
      if (parent && !stillUsed) doc.ydoc.getMap('folders').set(parent, true);
    });
  }, []);

  const removeFolder = useCallback((dirPath) => {
    const doc = docRef.current;
    if (!doc) throw new Error('Not connected to the room yet.');

    const occupied = [...doc.ydoc.getMap('files').keys()]
      .some((filePath) => filePath.startsWith(`${dirPath}/`));
    if (occupied) throw new Error(`${dirPath} still has files in it.`);

    doc.ydoc.getMap('folders').delete(dirPath);
  }, []);

  // Explicit empty folders and the folders implied by file paths render as one tree.
  const roomTree = useMemo(() => buildTree([
    ...folderPaths.map((dirPath) => ({ path: dirPath, type: 'tree' })),
    ...filePaths.map((filePath) => ({ path: filePath, type: 'blob' })),
  ]), [filePaths, folderPaths]);

  const activeLanguage = languageForPath(activePath);

  const runCode = () => {
    setIsExecuting(true);
    // Executing with the console collapsed would look like nothing happened.
    setConsoleOpen(true);
    setOutPut("Executing...");
    // The server runs its own authoritative copy of the code.
    socket.emit("compileCode", { roomId, path: activePath, input: userInput });
  };

  if (!joined) {
    return <div className='join-container'>
      <div className='join-form'>
        <h1>Join Code Room</h1>
        <input type='text' placeholder='Room Id' value={roomId}
          onChange={(e) => setRoomId(e.target.value)} />
        <input type='text' placeholder='Your Name' value={userName}
          onChange={(e) => setUserName(e.target.value)} />
        <input type='password' placeholder='Room Password (optional)' value={roomPassword}
          onChange={(e) => setRoomPassword(e.target.value)} />
        <button onClick={joinRoom}>Join Room</button>
        {joinError && <p className="error">{joinError}</p>}
      </div>
    </div>
  }

  return (
    <div className='editor-container'>
      {/* Collapsing hides the zones with CSS rather than unmounting them, so the
          GitHub panel keeps its token and loaded repository. */}
      <aside className={sidebarOpen ? 'sidebar' : 'sidebar collapsed'}>
        <div className='sidebar-header'>
          <div className='room-line'>
            <h2 title={roomId}>Room {roomId}</h2>
            <button
              onClick={copyRoomId}
              className='copy-button'
              title='Copy room id'
            >
              {copySuccess ? '✓ Copied' : 'Copy'}
            </button>
            <button
              className='collapse-toggle'
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
              title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              {sidebarOpen ? '«' : '»'}
            </button>
          </div>
        </div>

        {/* Only this zone scrolls, so the header and Leave Room can never be
            pushed off-screen by an expanded panel. */}
        <div className='sidebar-scroll'>
          {!connected && (
            <p className='connection-status'>Disconnected — reconnecting…</p>
          )}
          {connected && !synced && (
            <p className='connection-status'>Syncing…</p>
          )}

          <h3 className='sidebar-title'>Users in room</h3>
          <ul className='user-list'>
            {users.map((user, index) => (
              <li key={`${user}-${index}`}>
                <span className='user-dot' style={{ backgroundColor: colorFor(user) }} />
                <span className='user-name'>{user}</span>
              </li>
            ))}
          </ul>
          <p className='typing-indicator'>{typing}</p>

          <FilesPanel
            nodes={roomTree}
            activePath={activePath}
            viewers={viewers}
            fileCount={filePaths.length}
            onSelect={setActivePath}
            onCreateFile={createFile}
            onCreateFolder={createFolder}
            onRename={renameFile}
            onDelete={deleteFile}
            onRemoveFolder={removeFolder}
            disabled={!synced}
          />

          <GitHubPanel
            onOpenFile={importIntoEditor}
            onImportMany={importManyIntoEditor}
            getCode={readCode}
            disabled={!synced}
          />
        </div>

        <div className='sidebar-footer'>
          <button className='leave-button' onClick={leaveRoom}>Leave Room</button>
        </div>
      </aside>

      <main className='editor-wrapper'>
        <div className='editor-toolbar'>
          <select
            className='file-selector'
            value={activePath}
            onChange={(e) => setActivePath(e.target.value)}
            title='File to edit'
          >
            {filePaths.map((filePath) => (
              <option key={filePath} value={filePath}>{filePath}</option>
            ))}
          </select>
          <span className='language-badge'>{activeLanguage || 'text'}</span>
          <button
            className='console-toggle'
            onClick={() => setConsoleOpen((open) => !open)}
            aria-expanded={consoleOpen}
            title={consoleOpen ? 'Hide the console' : 'Show the console'}
          >
            {consoleOpen ? '▾' : '▸'} Console
          </button>
          <button
            className='run-btn'
            onClick={runCode}
            disabled={isExecuting || !activeLanguage}
            title={activeLanguage ? 'Run this file' : 'This file type cannot be run'}
          >
            {isExecuting ? 'Executing…' : '▶ Execute'}
          </button>
        </div>

        <div className='editor-surface'>
          {/* No value/language props: the model is owned by the Yjs binding, and
              letting the wrapper reset it would fight the CRDT. */}
          <Editor
            height='100%'
            defaultLanguage='javascript'
            defaultValue=''
            theme='vs-dark'
            keepCurrentModel
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              scrollBeyondLastLine: false,
              // Without this Monaco keeps its first measured size and leaves a dead
              // gutter whenever the surrounding layout changes.
              automaticLayout: true,
            }}
            onMount={handleEditorDidMount}
          />
        </div>

        {/* Hidden with CSS rather than unmounted — cheaper than remounting two
            textareas on every toggle. */}
        <div className={consoleOpen ? 'console-stack' : 'console-stack collapsed'}>
          <label className='console-pane console-pane-input'>
            <span className='console-label'>stdin</span>
            <textarea
              className='input-console'
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder='Input for your program…'
            />
          </label>
          <label className='console-pane console-pane-output'>
            <span className='console-label'>Output</span>
            <textarea
              className='output-console'
              value={outPut}
              readOnly
              placeholder='Output will appear here…'
            />
          </label>
        </div>
      </main>
    </div>
  )
}

export default App
