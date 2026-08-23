// Corporate networks intercept TLS with their own CA, which Node doesn't trust.
// Only relax verification in local dev — never in production.
if (process.env.NODE_ENV !== 'production') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import axios from 'axios';
import path from "path";

const app = express();
const server = http.createServer(app);
const io = new Server(server,{
    cors: {
        origin: '*',
    },
}
);
const rooms = new Map();

// Wandbox compiler ids for the languages exposed in the frontend selector
const WANDBOX_COMPILERS = {
    javascript: { compiler: "nodejs-20.17.0" },
    python: { compiler: "cpython-3.13.8" },
    java: { compiler: "openjdk-jdk-21+35" },
    cpp: { compiler: "gcc-13.2.0", options: "warning,gnu++17" },
};

io.on('connection',(socket)=>{
    console.log("User connected:", socket.id);
    
    let currentRoom = null;
    let currentUser = null;

    // inside io.on("connection", (socket) => { ... })

socket.on('join', ({ roomId, userName, password }) => {
    if (currentRoom) {
        socket.leave(currentRoom);
        rooms.get(currentRoom).users.delete(currentUser);
        io.to(currentRoom).emit("userJoined", Array.from(rooms.get(currentRoom).users));
    }

    // if room does not exist, create with password
    if (!rooms.has(roomId)) {
        rooms.set(roomId, { 
            users: new Set(), 
            code: "console.log('Hello World');", 
            password: password || null 
        });
    }

    const room = rooms.get(roomId);

    // if room has password and it doesn't match
    if (room.password && room.password !== password) {
        socket.emit("joinError", "Invalid room password ❌");
        return;
    }

    // store user info
    currentRoom = roomId;
    currentUser = userName;

    socket.join(roomId);
    room.users.add(userName);

    socket.emit("codeUpdate", room.code);
    io.to(roomId).emit("userJoined", Array.from(room.users));
});


    socket.on("codeChange",({roomId,code})=>{
        if(rooms.has(roomId)){
            rooms.get(roomId).code = code;
        }
        socket.to(roomId).emit("codeUpdate",code)
    });

    socket.on("leaveRoom",()=>{
        if(currentRoom&&currentUser){
            rooms.get(currentRoom).users.delete(currentUser);
            io.to(currentRoom).emit("userJoined",Array.from(rooms.get(currentRoom).users));

            socket.leave(currentRoom);

            currentRoom=null;
            currentUser=null;
        }
    })

    socket.on("typing",({roomId,userName})=>{
        socket.to(roomId).emit("userTyping",userName);
    })

    socket.on("cursorChange", ({ roomId, userName, position }) => {
        socket.to(roomId).emit("cursorUpdate", { userName, position });
    });


    socket.on("languageChange",({roomId,language})=>{
        io.to(roomId).emit("languageUpdate",language);
    })

    // Wandbox pins its own runtime versions, so the client's `version` is ignored.
    socket.on("compileCode",async ({code,roomId,language,input})=>{
        if(!rooms.has(roomId)) return;
        const room = rooms.get(roomId);

        const sendOutput = (output) => {
            room.output = output;
            io.to(roomId).emit("codeResponse", { run: { output } });
        };

        const target = WANDBOX_COMPILERS[language];
        if(!target){
            sendOutput(`Unsupported language: ${language}`);
            return;
        }

        try{
            const response = await axios.post(
                "https://wandbox.org/api/compile.json",
                {
                    code,
                    compiler: target.compiler,
                    options: target.options || "",
                    stdin: input || "",
                },
                { timeout: 30000 }
            );

            const d = response.data;
            // Compile errors live in compiler_error; runtime output in program_output/error.
            const output = [d.compiler_error, d.program_output, d.program_error]
                .filter(Boolean).join("").trim();
            sendOutput(output || "(no output)");
        }catch(err){
            console.error("Compile failed:", err.response?.status, err.message);
            sendOutput(`Execution failed: ${err.message}`);
        }
    })

    socket.on("disconnect",()=>{
        if(currentRoom&&currentUser){
            rooms.get(currentRoom).users.delete(currentUser);
            io.to(currentRoom).emit("userJoined",Array.from(rooms.get(currentRoom).users));
        }
        console.log("user disconneted.")
    })

});

const port = process.env.PORT || 5000;

const __dirname = path.resolve();

app.use(express.static(path.join(__dirname, "/frontend/dist")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "dist", "index.html"));
});

server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  
});
