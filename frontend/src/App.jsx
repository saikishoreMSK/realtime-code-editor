import './App.css'
import io from 'socket.io-client';
import React, { useEffect, useState, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { snippets } from './components/snippets';

const socket = io("https://realtime-collaborative-code-editor-d1ni.onrender.com");

const App = () => {
  const [Joined, setJoined] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [userName,setUserName] = useState("");
  const [language, setLanguage] = useState("javascript");
  const [code,setCode] = useState("");
  const [copySuccess,setCopySuccess] = useState("") 
  const [users,setUsers] = useState([]);
  const [typing,setTyping] = useState("");
  const [cursors, setCursors] = useState({});
  const editorRef = useRef(null);
  const [outPut,setOutPut] = useState("");
  // eslint-disable-next-line no-unused-vars
  const [version,setVersion]= useState("*");
  const cursorDecorationsRef = useRef({});
  
  // For code persistence across the languages
  const [languageCodes, setLanguageCodes] = useState({
  javascript: snippets.javascript,
  python: snippets.python,
  java: snippets.java,
  cpp: snippets.cpp,
});
const [roomPassword, setRoomPassword] = useState("");
const [joinError, setJoinError] = useState("");


  useEffect(()=>{
    socket.on("userJoined",(users)=>{
      setUsers(users);
    })
    socket.on("joinError", (msg) => {
    setJoinError(msg);
    setJoined(false);
  });
    socket.on("codeUpdate",(newCode)=>{
      setCode(newCode);
    })
    socket.on("userTyping",(user)=>{
      setTyping(`${user.slice(0,8)}... is Typing`);
      setTimeout(()=>setTyping(""),2000);
    })
    socket.on("cursorUpdate", ({ userName, position }) => {
    setCursors(prev => ({...prev,[userName]: position,
      }));
    });
    socket.on("languageUpdate",(newLanguage)=>{
      setLanguage(newLanguage);
    })
    
    socket.on("codeResponse",(response)=>{
      setOutPut(response.run.output);
    })
    return()=>{
      socket.off("userJoined");
      socket.off("joinError");
      socket.on("codeUpdate", (newCode) => {
          setCode(newCode);
          setJoined(true);
        });
      socket.off("userTyping");
      socket.off("cursorUpdate");
      socket.off("codeResponse");
    }
  },[])

  useEffect(()=>{
    const handleBeforeUnload =()=>{
      socket.emit("leaveRoom");
    };

    window.addEventListener("beforeunload",handleBeforeUnload);

    return ()=>{
      window.removeEventListener("beforeunload",handleBeforeUnload);
    }
  },[])
  useEffect(() => {
    if (!editorRef.current) return;

    Object.entries(cursors).forEach(([name, pos]) => {
      if (name === userName) return; // don't show your own cursor

      // Clear old decorations for this user
      const oldDecorations = cursorDecorationsRef.current[name] || [];

      // Apply new decoration
      const newDecorations = editorRef.current.deltaDecorations(oldDecorations, [
        {
          range: new window.monaco.Range(
            pos.lineNumber,
            pos.column,
            pos.lineNumber,
            pos.column
          ),
          options: {
            className: "remote-cursor",
            hoverMessage: { value: `${name}'s cursor` }, // ✅ name tooltip
          },
        },
      ]);

      // Save for cleanup next time
      cursorDecorationsRef.current[name] = newDecorations;
    });
  }, [cursors, userName]);



  // joinRoom function
  const joinRoom = () => {
    if (roomId && userName) {
      socket.emit("join", { roomId, userName, password: roomPassword });
      
    }
  };
  const leaveRoom = () =>{
    socket.emit("leaveRoom");
    setJoined(false);
    setRoomId("");
    setUserName("");
    setCode("");
    setLanguage("javascript");
  }
  const copyRoomId = () =>{
    navigator.clipboard.writeText(roomId)
    setCopySuccess("Copied")
    setTimeout(()=>setCopySuccess(""),2000);
  }
  
  const handleCursorChange = (e) => {
    if (e && e.position) {
      socket.emit("cursorChange", {roomId,userName,position: e.position,});
    }
  };
  const handleEditorDidMount = (editor) => {
    editorRef.current = editor;
    editor.onDidChangeCursorPosition(handleCursorChange);
  };

  const handleCodeChange = (newCode) => {
  setCode(newCode);
  setLanguageCodes(prev => ({
    ...prev,
    [language]: newCode, // update current language’s slot
  }));
  socket.emit("codeChange", { roomId, code: newCode });
  socket.emit("typing", { roomId, userName });
};

    
  const handleLanguageChange = (e) => {
    const newLanguage = e.target.value;

    // Save current code into current language slot
    setLanguageCodes(prev => ({
      ...prev,
      [language]: code, // save the old code
    }));

    // Load code for the new language
    const newCode = languageCodes[newLanguage] || snippets[newLanguage];

    setLanguage(newLanguage);
    setCode(newCode);

    // broadcast changes
    socket.emit("languageChange", { roomId, language: newLanguage });
    socket.emit("codeChange", { roomId, code: newCode });
  };


  const [userInput,setUserInput] = useState("");

  const runCode = () =>{
    socket.emit("compileCode",{code,roomId,language,version,input:userInput});
  }

  if(!Joined) {
    return <div className='join-container '>
      <div className='join-form'>
  <h1>Join Code Room</h1>
  <input type='text' placeholder='Room Id' value={roomId} onChange={(e)=>setRoomId(e.target.value)}
  />
  <input type='text' placeholder='Your Name' value={userName} onChange={(e)=> setUserName(e.target.value)}
  />
  <input type='password' placeholder='Room Password (optional)' value={roomPassword} onChange={(e)=> setRoomPassword(e.target.value)}
  />
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
          {copySuccess&&<span className='copy-success'>${copySuccess}</span>}
        </div>
        <h3>Users in Room:</h3>
        <ul>
          {users.map((user,index)=>(
            <li key={index}>{user.slice(0,8)}...</li>
          ))}
        </ul>
        <p className='typing-indicator'>{typing}</p>
        <select 
          className='language-selector' 
          value={language} 
          onChange={handleLanguageChange}
        >
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
          <option value="java">Java</option>
          <option value="cpp">C++</option>
        </select>
        <button className='leave-button' onClick={leaveRoom}>Leave Room</button>
      </div>
      <div className='editor-wrapper'>
        <Editor 
        height={"60%"} 
        defaultLanguage={language}
        language={language}
        value={code}
        onChange={handleCodeChange}
        theme='vs-dark'
        options={{
          minimap:{enabled: false},
          fontSize: 14
        }} onMount={handleEditorDidMount}
        />
        <textarea className='input-console' value={userInput} 
        onChange={(e)=>setUserInput(e.target.value)} 
        placeholder='Enter Input here'/>

        <button className='run-btn' onClick={runCode}>Execute</button>
        <textarea className='output-console' value={outPut} readOnly 
        placeholder='Output will display here...'></textarea>
      </div>
    </div>
  )
}

export default App
