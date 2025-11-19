process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import express from 'express';
import http from 'http';
import { version } from 'os';
import { Server } from 'socket.io';
import axios from 'axios';
import { resolveNaptr } from 'dns';
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const server = http.createServer(app);
const io = new Server(server,{
    cors: {
        origin: '*',
    },
}
);
const rooms = new Map();

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

    socket.on("compileCode",async ({code,roomId,language,version,input})=>{
        if(rooms.has(roomId)){
            const room = rooms.get(roomId);
            const response = await axios.post(
                "https://emkc.org/api/v2/piston/execute",
                {
                    language,
                    version,
                    files:[
                        {
                            content: code,
                        },
                    ],
                    stdin:input,
                }
            );
            room.output = response.data.run.output;
            io.to(roomId).emit("codeResponse",response.data);
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