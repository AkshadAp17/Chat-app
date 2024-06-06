import path from "path";
import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.routes.js";
import messageRoutes from "./routes/message.routes.js";
import userRoutes from "./routes/user.routes.js";

import connectToMongoDB from "./db/connectToMongoDB.js";
import { app, server } from "./socket/socket.js";

dotenv.config(); // Load environment variables from .env file

const __dirname = path.resolve();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json()); // Parse JSON payloads
app.use(cookieParser()); // Parse cookies

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/users", userRoutes);

// Serve static files from the frontend build directory
app.use(express.static(path.join(__dirname, "frontend", "dist")));

app.get("*", (req, res) => {
	res.sendFile(path.join(__dirname, "frontend", "dist", "index.html"));
});

// Start the server and connect to MongoDB
server.listen(PORT, async () => {
	try {
		await connectToMongoDB(); // Ensure database connection is established
		console.log(`Server Running on port ${PORT}`);
	} catch (error) {
		console.error("Failed to connect to MongoDB", error);
		process.exit(1); // Exit the process with an error code if the database connection fails
	}
});
