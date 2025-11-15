import { WebSocketServer } from 'ws';
import { MongoClient } from 'mongodb';

// Environment variables for Render
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://boutoutanetakey_db_user:T%40aki232323@cluster0.vdeznzs.mongodb.net/chatApp?retryWrites=true&w=majority";

const wss = new WebSocketServer({ 
  port: PORT,
  host: '0.0.0.0'  // Important for Render
});

console.log(`🚀 WebSocket server running on port ${PORT}`);

// MongoDB connection
const client = new MongoClient(MONGODB_URI);

let db;
let usersCollection;
let messagesCollection;

// Connect to MongoDB
async function connectDB() {
  try {
    await client.connect();
    db = client.db('chatApp');
    usersCollection = db.collection('users');
    messagesCollection = db.collection('messages');
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
  }
}

// Store active WebSocket connections
let activeUsers = new Map();

// Initialize database connection
connectDB();

wss.on("connection", (socket) => {
  console.log("Client connected");
  
  let currentUsername = null;

  // Ask for username when client connects
  socket.send(JSON.stringify({
    type: "request_username"
  }));

  socket.on("message", async (data) => {
    try {
      const message = JSON.parse(data);
      console.log("Received:", message);
      
      // Handle username registration
      if (message.type === "register_username") {
        const username = message.username.trim();
        
        // Check if username is taken (in active users)
        if (activeUsers.has(username)) {
          socket.send(JSON.stringify({
            type: "error",
            message: "Username already taken"
          }));
          return;
        }
        
        // Check if we already have 2 users
        if (activeUsers.size >= 2) {
          socket.send(JSON.stringify({
            type: "error", 
            message: "Chat is full (max 2 users)"
          }));
          return;
        }
        
        // Save user to database (or update if exists)
        try {
          if (usersCollection) {
            await usersCollection.updateOne(
              { username: username },
              { 
                $set: { 
                  username: username,
                  lastSeen: new Date(),
                  isOnline: true
                } 
              },
              { upsert: true }
            );
          }
        } catch (dbError) {
          console.log('Database save skipped:', dbError.message);
        }
        
        // Register user in active connections
        activeUsers.set(username, socket);
        currentUsername = username;
        socket.username = username;
        
        console.log(`User registered: ${username}`);
        
        // Notify the user
        socket.send(JSON.stringify({
          type: "username_accepted",
          username: username
        }));
        
        // Load previous messages from database
        try {
          if (messagesCollection) {
            const previousMessages = await messagesCollection
              .find({})
              .sort({ timestamp: 1 })
              .limit(50)
              .toArray();
            
            previousMessages.forEach(msg => {
              socket.send(JSON.stringify({
                type: "chat_message",
                from: msg.sender,
                message: msg.message,
                timestamp: msg.timestamp,
                isHistory: true
              }));
            });
          }
        } catch (dbError) {
          console.log('Could not load message history:', dbError.message);
        }
        
        // Notify other user about new user
        broadcastToOthers(socket, {
          type: "user_joined",
          username: username
        });
        
        // Send the other user's username to the new user
        const otherUser = Array.from(activeUsers.keys()).find(u => u !== username);
        if (otherUser) {
          socket.send(JSON.stringify({
            type: "other_user",
            username: otherUser
          }));
        }
        
        return;
      }
      
      // Handle chat messages
      if (message.type === "chat_message" && currentUsername) {
        const otherUser = Array.from(activeUsers.entries()).find(([name, sock]) => name !== currentUsername);
        
        if (otherUser) {
          const [otherUsername, otherSocket] = otherUser;
          
          // Create message object
          const messageObj = {
            sender: currentUsername,
            message: message.message,
            timestamp: new Date(),
            recipient: otherUsername
          };
          
          // Save message to database
          try {
            if (messagesCollection) {
              const result = await messagesCollection.insertOne(messageObj);
              console.log('Message saved to DB with id:', result.insertedId);
            }
          } catch (dbError) {
            console.log('Message not saved to DB:', dbError.message);
          }
          
          // Send to the other user
          otherSocket.send(JSON.stringify({
            type: "chat_message",
            from: currentUsername,
            message: message.message,
            timestamp: messageObj.timestamp
          }));
          
          // Confirm to sender
          socket.send(JSON.stringify({
            type: "message_sent"
          }));
          
          // Also send to sender for their own UI
          socket.send(JSON.stringify({
            type: "chat_message",
            from: currentUsername,
            message: message.message,
            timestamp: messageObj.timestamp,
            isMe: true
          }));
          
        } else {
          socket.send(JSON.stringify({
            type: "error",
            message: "No other user connected"
          }));
        }
      }
      
    } catch (error) {
      console.log("Error:", error);
    }
  });

  socket.on("close", async () => {
    if (currentUsername) {
      console.log(`User disconnected: ${currentUsername}`);
      
      // Remove from active users
      activeUsers.delete(currentUsername);
      
      // Update user status in database
      try {
        if (usersCollection) {
          await usersCollection.updateOne(
            { username: currentUsername },
            { 
              $set: { 
                isOnline: false,
                lastSeen: new Date()
              } 
            }
          );
        }
      } catch (dbError) {
        console.log('Could not update user status:', dbError.message);
      }
      
      // Notify other users
      broadcastToOthers(socket, {
        type: "user_left", 
        username: currentUsername
      });
    }
  });
});

// Helper function to broadcast to all other users
function broadcastToOthers(senderSocket, message) {
  activeUsers.forEach((socket, username) => {
    if (socket !== senderSocket && socket.readyState === 1) {
      socket.send(JSON.stringify(message));
    }
  });
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  try {
    if (usersCollection) {
      await usersCollection.updateMany(
        { isOnline: true },
        { $set: { isOnline: false, lastSeen: new Date() } }
      );
    }
    await client.close();
  } catch (error) {
    console.log('Error during shutdown:', error);
  }
  process.exit(0);
});