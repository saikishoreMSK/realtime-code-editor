import './App.css'
import io from 'socket.io-client';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import * as Y from 'yjs';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { MonacoBinding } from 'y-monaco';

const socket = io();

const LANGUAGES = [
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'cpp', label: 'C++' },
];

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

const App = () => {
  const [joined, setJoined] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [userName, setUserName] = useState("");
  const [roomPassword, setRoomPassword] = useState("");
  const [joinError, setJoinError] = useState("");
  const [language, setLanguage] = useState("javascript");
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

    // The active language lives in the CRDT too, so it syncs to everyone and
    // persists with the snapshot — a late joiner gets the right language, not just
    // the right code.
    ydoc.getMap('meta').observe(() => {
      const next = ydoc.getMap('meta').get('language');
      if (next) setLanguage(next);
    });

    docRef.current = { ydoc, awareness };
    return docRef.current;
  }, []);

  // Point the editor at the Y.Text for the active language.
  const bindLanguage = useCallback((lang) => {
    const doc = docRef.current;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!doc || !editor || !monaco) return;

    // A stale binding would keep writing edits into the previous language's text.
    bindingRef.current?.destroy();
    bindingRef.current = null;

    // The server seeds every language. Creating one here would race that seed and
    // leave this editor bound to an orphaned Y.Text.
    const files = doc.ydoc.getMap('files');
    const ytext = files.get(lang);
    if (!ytext) return;

    let model = modelsRef.current[lang];
    if (!model || model.isDisposed()) {
      // Start empty and let the binding fill it, so content is never inserted twice.
      model = monaco.editor.createModel('', lang);
      modelsRef.current[lang] = model;
    }
    editor.setModel(model);

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
      setTyping(`${user.slice(0, 8)}... is Typing`);
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

  useEffect(() => {
    if (joined && synced) bindLanguage(language);
  }, [joined, synced, language, bindLanguage]);

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
    setLanguage("javascript");
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

    bindLanguage(language);
  };

  const handleLanguageChange = (e) => {
    const next = e.target.value;
    // Writing to the CRDT broadcasts the change; the observer updates local state.
    docRef.current?.ydoc.getMap('meta').set('language', next);
    setLanguage(next);
  };

  const runCode = () => {
    setIsExecuting(true);
    setOutPut("Executing...");
    // The server runs its own authoritative copy of the code.
    socket.emit("compileCode", { roomId, input: userInput });
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
      <div className="sidebar">
        <div className="room-info">
          <h2>Code Room {roomId}</h2>
          <button onClick={copyRoomId} className='copy-button'>Copy Id</button>
          {copySuccess && <span className='copy-success'>{copySuccess}</span>}
        </div>
        <h3>Users in Room:</h3>
        <ul>
          {users.map((user, index) => (
            <li key={index}>
              <span className='user-dot' style={{ backgroundColor: colorFor(user) }} />
              {user.slice(0, 8)}...
            </li>
          ))}
        </ul>
        <p className='typing-indicator'>{typing}</p>
        {!connected && (
          <p className='connection-status'>Disconnected — reconnecting…</p>
        )}
        {connected && !synced && (
          <p className='connection-status'>Syncing…</p>
        )}
        <select
          className='language-selector'
          value={language}
          onChange={handleLanguageChange}
        >
          {LANGUAGES.map(({ id, label }) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
        <button className='leave-button' onClick={leaveRoom}>Leave Room</button>
      </div>
      <div className='editor-wrapper'>
        {/* No value/language props: the model is owned by the Yjs binding, and letting
            the wrapper reset it would fight the CRDT. */}
        <Editor
          height={"60%"}
          defaultLanguage="javascript"
          defaultValue=""
          theme='vs-dark'
          keepCurrentModel
          options={{
            minimap: { enabled: false },
            fontSize: 14
          }}
          onMount={handleEditorDidMount}
        />
        <textarea className='input-console' value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          placeholder='Enter Input here' />

        <button className='run-btn' onClick={runCode} disabled={isExecuting}>
          {isExecuting ? 'Executing...' : 'Execute'}
        </button>
        <textarea className='output-console' value={outPut} readOnly
          placeholder='Output will display here...'></textarea>
      </div>
    </div>
  )
}

export default App
