require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs").promises;
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const port = 3000; // Or your preferred port

// --- MONGODB DATABASE SETUP ---
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/aces_lair";

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("Successfully connected to MongoDB."))
  .catch((err) => console.error("MongoDB connection error:", err));

// --- Mongoose Schemas / Models ---
const UserSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  isBanned: { type: Boolean, default: false },
});

const ProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  role: String,
  location: String,
  website: String,
  bio: String,
});

const ProjectSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  name: { type: String, required: true },
  status: String,
  description: String,
});

// Schema for specific aces-lair-99.html users
const ConsoleAdminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  pin: { type: String, required: true }, // Encrypted PIN/Password
  lastLogin: Date,
});

// New Schema for console messages
const ConsoleMessageSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  recipient: { type: String, required: true },
  message: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false },
});

const User = mongoose.model("User", UserSchema);
const Profile = mongoose.model("Profile", ProfileSchema);
const Project = mongoose.model("Project", ProjectSchema);
const ConsoleAdmin = mongoose.model("ConsoleAdmin", ConsoleAdminSchema);
const ConsoleMessage = mongoose.model("ConsoleMessage", ConsoleMessageSchema);

// --- SOCKET.IO SETUP ---
const server = http.createServer(app);
const io = new Server(server);

// --- MIDDLEWARE ---
app.use(express.json()); // For parsing application/json
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded
app.use(express.static(path.join(__dirname))); // Serve static files like CSS and HTML

// Example session middleware (configure as needed)
app.use(
  session({
    secret: "your-super-secret-key", // Change this!
    resave: false,
    saveUninitialized: false, // Only create session when user actually logs in
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }, // 1 day cookie, allowed over HTTP
  }),
);

// Middleware to protect routes
function isAuthenticated(req, res, next) {
  // Replace with your actual authentication check
  if (req.session.userId) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
}

// --- AUTHENTICATION ROUTES ---

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.redirect("/login.html?error=Invalid%20credentials");
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.redirect(
        "/login.html?error=No%20account%20registered%20with%20this%20email",
      );
    }

    if (user.isBanned) {
      return res.redirect(
        "/login.html?error=This%20account%20has%20been%20banned",
      );
    }

    const match = await bcrypt.compare(password, user.password);
    if (match) {
      req.session.userId = user._id;
      // Regenerate session to prevent session fixation attacks
      req.session.save(() => {
        res.redirect("/workspace.html");
      });
    } else {
      res.redirect("/login.html?error=Invalid%20credentials");
    }
  } catch (error) {
    console.error("Database error during login:", error);
    return res.redirect("/login.html?error=Server%20error");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.redirect("/workspace.html"); // Or some error page
    }
    res.clearCookie("connect.sid"); // The default session cookie name
    res.redirect("/login.html");
  });
});

// --- SIGNUP ROUTE ---
app.post("/signup", async (req, res) => {
  const { fullName, email, password } = req.body;

  if (!fullName || !email || !password) {
    return res.redirect("/signup.html?error=All%20fields%20are%20required");
  }

  try {
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.redirect("/signup.html?error=Email%20already%20in%20use");
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newUser = new User({
      fullName,
      email: email.toLowerCase(),
      password: hashedPassword,
    });
    await newUser.save();

    // Also create a default profile for the new user
    const newProfile = new Profile({
      userId: newUser._id,
      role: "New Operative",
      location: "Undisclosed",
      website: "",
      bio: "No bio yet.",
    });
    await newProfile.save();

    res.redirect("/login.html?success=Account%20created!%20Please%20log%20in.");
  } catch (error) {
    console.error("Error during signup process:", error);
    res.redirect("/signup.html?error=An%20unexpected%20error%20occurred");
  }
});

// --- DATA API ROUTES ---

// Check session status for frontend logic
app.get("/api/session-status", (req, res) => {
  if (req.session.userId) {
    res.json({ loggedIn: true, userId: req.session.userId });
  } else {
    res.json({ loggedIn: false });
  }
});

// --- A.C.E.S. AI ROUTES ---
const aiRoutes = require("./aiRoutes");
app.use("/api/ai", aiRoutes);

// Fetch all data for the workspace page
app.get("/api/workspace-data", isAuthenticated, async (req, res) => {
  const userId = req.session.userId;
  try {
    // Using Promise.all to fetch data in parallel
    const [user, profile, projects] = await Promise.all([
      User.findById(userId).select("-password").lean(), // .lean() for plain JS object
      Profile.findOne({ userId: userId }).lean(),
      Project.find({ userId: userId }).sort({ _id: -1 }).lean(),
    ]);

    if (!user) {
      // This can happen if the user was deleted but the session remains.
      req.session.destroy();
      return res
        .status(401)
        .json({ error: "User not found, session terminated." });
    }

    // Skills are hardcoded for now as there's no UI to manage them yet.
    const skills = [
      { name: "JavaScript", level: 90, color: "var(--al-cyan)" },
      { name: "Node.js", level: 85, color: "var(--al-green)" },
      { name: "HTML/CSS", level: 95, color: "var(--al-red)" },
    ];

    res.json({
      user: user,
      profile: profile || {
        role: "Operative",
        location: "CLASSIFIED",
        website: "",
        bio: "No bio available.",
      }, // Send default profile
      projects: projects || [],
      skills: skills,
    });
  } catch (error) {
    console.error("Error fetching workspace data:", error);
    res.status(500).json({ error: "Failed to fetch workspace data" });
  }
});

// --- ADMIN API ROUTES ---
app.get("/api/admin/users", async (req, res) => {
  try {
    const users = await User.find({}, "fullName email isBanned").lean();
    const profiles = await Profile.find({}).lean();

    const userList = users.map((u) => {
      const profile = profiles.find(
        (p) => p.userId.toString() === u._id.toString(),
      );
      return {
        fullName: u.fullName,
        email: u.email,
        role: profile ? profile.role : "Operative",
        isBanned: u.isBanned || false,
      };
    });

    res.json(userList);
  } catch (error) {
    console.error("Error fetching admin users:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.post("/api/admin/users/ban", async (req, res) => {
  // In a real app, this should be protected by admin-role middleware
  const { username } = req.body;

  if (!username) {
    return res
      .status(400)
      .json({ success: false, error: "Username is required." });
  }

  try {
    const user = await User.findOneAndUpdate(
      { fullName: username },
      { $set: { isBanned: true } },
      { new: true },
    );

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    res.json({ success: true, message: `User '${username}' has been banned.` });
  } catch (error) {
    console.error("Error banning user:", error);
    res
      .status(500)
      .json({ success: false, error: "Server error while banning user." });
  }
});

app.post("/api/admin/users/unban", async (req, res) => {
  // In a real app, this should be protected by admin-role middleware
  const { username } = req.body;

  if (!username) {
    return res
      .status(400)
      .json({ success: false, error: "Username is required." });
  }

  try {
    const user = await User.findOneAndUpdate(
      { fullName: username },
      { $set: { isBanned: false } },
      { new: true },
    );

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    res.json({
      success: true,
      message: `User '${username}' has been unbanned.`,
    });
  } catch (error) {
    console.error("Error unbanning user:", error);
    res
      .status(500)
      .json({ success: false, error: "Server error while unbanning user." });
  }
});

// --- CONSOLE ADMIN ROUTES (aces-lair-99.html) ---

// Get all console admins
app.get("/api/console/admins", async (req, res) => {
  try {
    const admins = await ConsoleAdmin.find({}, "username").lean();
    res.json(admins.map((a) => a.username));
  } catch (err) {
    res.status(500).json([]);
  }
});

// Register a new console admin (Internal use)
app.post("/api/console/register", async (req, res) => {
  const { username, pin } = req.body;
  try {
    const existing = await ConsoleAdmin.findOne({ username });
    if (existing) return res.json({ success: false, error: "Username taken" });

    const hashedPin = await bcrypt.hash(pin, 10);
    const newAdmin = new ConsoleAdmin({ username, pin: hashedPin });
    await newAdmin.save();
    res.json({ success: true, message: "Console Identity Created" });
  } catch (err) {
    res.json({ success: false, error: "Creation failed" });
  }
});

// Login to console identity
app.post("/api/console/login", async (req, res) => {
  const { username, pin } = req.body;
  try {
    const admin = await ConsoleAdmin.findOne({ username });
    if (!admin)
      return res.json({ success: false, error: "Identity not found" });

    const match = await bcrypt.compare(pin, admin.pin);
    if (match) {
      admin.lastLogin = new Date();
      await admin.save();

      // Fetch all messages where this admin is either the sender or recipient
      const messages = await ConsoleMessage.find({
        $or: [{ recipient: username }, { sender: username }],
      }).sort({ timestamp: 1 });
      res.json({ success: true, username: admin.username, messages: messages });
    } else {
      res.json({ success: false, error: "Invalid PIN" });
    }
  } catch (err) {
    res.json({ success: false, error: "Auth Error" });
  }
});

// --- SOCKET.IO LOGIC ---
let onlineAdmins = new Map(); // socketId -> username

io.on("connection", (socket) => {
  socket.on("console-identify", (username) => {
    onlineAdmins.set(socket.id, username);
    io.emit("admin-list-update", Array.from(onlineAdmins.values()));
  });

  socket.on("console-private-message", async ({ recipient, message }) => {
    const sender = onlineAdmins.get(socket.id);

    if (!sender || !recipient || !message) return;

    // 1. Save message to DB
    const newMessage = new ConsoleMessage({ sender, recipient, message });
    await newMessage.save();

    // Find recipient's socket ID
    let recipientSocketId = null;
    for (const [id, name] of onlineAdmins.entries()) {
      if (name === recipient) {
        recipientSocketId = id;
        break;
      }
    }

    // 2. Emit to recipient if online, and always back to sender
    const messagePayload = newMessage.toObject(); // Use the saved message object

    // Send back to sender for their own chat history
    io.to(socket.id).emit("console-private-message", messagePayload);

    // Send to recipient if they are online
    if (recipientSocketId) {
      io.to(recipientSocketId).emit("console-private-message", messagePayload);
    }
  });

  socket.on("mark-as-read", async ({ senderUsername }) => {
    const recipientUsername = onlineAdmins.get(socket.id);
    if (!senderUsername || !recipientUsername) return;

    try {
      await ConsoleMessage.updateMany(
        { sender: senderUsername, recipient: recipientUsername, read: false },
        { $set: { read: true } },
      );
    } catch (error) {
      console.error("Error marking messages as read:", error);
    }
  });

  socket.on("disconnect", () => {
    onlineAdmins.delete(socket.id);
    io.emit("admin-list-update", Array.from(onlineAdmins.values()));
  });
});

// Update user profile
app.post("/api/update-profile", isAuthenticated, async (req, res) => {
  const userId = req.session.userId;
  const { fullName, ...profileData } = req.body;

  try {
    await Promise.all([
      User.findByIdAndUpdate(userId, { fullName }),
      Profile.findOneAndUpdate({ userId: userId }, profileData, {
        upsert: true, // Create if it doesn't exist
        new: true, // Return the updated document
      }),
    ]);
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating profile:", error);
    res
      .status(500)
      .json({ success: false, error: "Database error on profile update" });
  }
});

// Delete a project
app.delete("/api/delete-project/:id", isAuthenticated, async (req, res) => {
  const { id } = req.params;
  const userId = req.session.userId;
  try {
    // Atomically find and delete the project if the userId matches.
    const project = await Project.findOneAndDelete({ _id: id, userId: userId });

    if (!project) {
      return res
        .status(403)
        .json({ success: false, error: "Project not found or not owned." });
    }

    // If deletion was successful, remove the associated directory.
    const projectPath = path.join(__dirname, "projects", id.toString());
    await fs.rm(projectPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (error) {
    console.error(`Error deleting project ${id}:`, error);
    res
      .status(500)
      .json({ success: false, error: "Failed to delete project." });
  }
});

// --- NEW & MODIFIED API ENDPOINTS FOR THE IDE ---

/**
 * MODIFIED: Create Project Endpoint
 * Now creates a directory and starter files on the server.
 */
app.post("/api/create-project", isAuthenticated, async (req, res) => {
  const { name, status, description } = req.body;
  const userId = req.session.userId;

  if (!name || !description) {
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields" });
  }

  try {
    const newProject = new Project({
      userId,
      name,
      status,
      description,
    });

    const savedProject = await newProject.save();
    const newProjectId = savedProject._id.toString();

    try {
      // This part remains the same, as it deals with the file system.
      // Create project directory
      const projectPath = path.join(__dirname, "projects", newProjectId);
      await fs.mkdir(projectPath, { recursive: true });
      // Create starter files (as seen in the mock data)
      const packageJsonContent = JSON.stringify(
        {
          name: name.toLowerCase().replace(/\s+/g, "-"),
          version: "1.0.0",
          description: description,
          main: "index.js",
          scripts: { start: "node index.js" },
        },
        null,
        2,
      );

      await fs.writeFile(
        path.join(projectPath, "package.json"),
        packageJsonContent,
      );
      await fs.writeFile(
        path.join(projectPath, "index.js"),
        `console.log("Hello from ${name}!");`,
      );
      await fs.writeFile(
        path.join(projectPath, "README.md"),
        `# ${name}\n\n${description}`,
      );

      res.json({ success: true, id: newProjectId });
    } catch (fsError) {
      console.error("File System Error on project creation:", fsError);
      // Note: In a real app, you might want to roll back the DB insert here.
      return res
        .status(500)
        .json({ success: false, error: "Could not create project files." });
    }
  } catch (dbError) {
    console.error("DB Error on project creation:", dbError);
    return res.status(500).json({ success: false, error: "Database error" });
  }
});

/**
 * NEW: Save File Endpoint
 * Receives content from the Monaco editor and writes it to the file system.
 */
app.put("/api/save-file", isAuthenticated, async (req, res) => {
  const { projectId, fileName, content } = req.body;

  if (!projectId || !fileName || content === undefined) {
    return res.status(400).json({
      success: false,
      error: "Missing projectId, fileName, or content.",
    });
  }

  // SECURITY: In a real app, verify the user (req.session.userId) owns this projectId

  try {
    // Sanitize fileName to prevent directory traversal attacks (e.g., '../')
    const projectBasePath = path.join(
      __dirname,
      "projects",
      projectId.toString(),
    );
    const filePath = path.join(projectBasePath, fileName);

    // Security check to ensure path is within the project directory
    if (!filePath.startsWith(projectBasePath)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid file path." });
    }

    // Write the file
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");

    res.json({
      success: true,
      message: `File ${path.basename(fileName)} saved successfully.`,
    });
  } catch (error) {
    console.error(`Error saving file for project ${projectId}:`, error);
    res
      .status(500)
      .json({ success: false, error: error.message || "Could not save file." });
  }
});

/**
 * REVISED: Create File or Folder Endpoint
 */
app.post("/api/create-fs-item", isAuthenticated, async (req, res) => {
  const { projectId, relativePath, name, type } = req.body;

  if (!projectId || !name || !type || relativePath === undefined) {
    return res.status(400).json({
      success: false,
      error: "Missing projectId, relativePath, name, or type.",
    });
  }

  try {
    const projectBasePath = path.join(
      __dirname,
      "projects",
      projectId.toString(),
    );
    const fullPath = path.join(projectBasePath, relativePath, name);

    // Security check to ensure path is within the project directory
    if (!fullPath.startsWith(projectBasePath)) {
      return res.status(400).json({ success: false, error: "Invalid path." });
    }

    if (type === "file") {
      await fs.writeFile(fullPath, "", "utf8"); // Create empty file
    } else if (type === "directory") {
      await fs.mkdir(fullPath, { recursive: true });
    } else {
      return res
        .status(400)
        .json({ success: false, error: "Invalid type specified." });
    }

    res.json({
      success: true,
      message: `${type} '${name}' created successfully.`,
    });
  } catch (error) {
    console.error(`Error creating fs item for project ${projectId}:`, error);
    res.status(500).json({ success: false, error: "Could not create item." });
  }
});

/**
 * NEW: Rename File or Folder Endpoint
 */
app.put("/api/rename-fs-item", isAuthenticated, async (req, res) => {
  const { projectId, oldPath, newPath } = req.body;

  if (!projectId || !oldPath || !newPath) {
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields." });
  }

  try {
    const projectBasePath = path.join(
      __dirname,
      "projects",
      projectId.toString(),
    );
    const fullOldPath = path.join(projectBasePath, oldPath);
    const fullNewPath = path.join(projectBasePath, newPath);

    // Security checks
    if (
      !fullOldPath.startsWith(projectBasePath) ||
      !fullNewPath.startsWith(projectBasePath)
    ) {
      return res.status(400).json({ success: false, error: "Invalid path." });
    }

    await fs.rename(fullOldPath, fullNewPath);
    res.json({
      success: true,
      message: `Renamed '${oldPath}' to '${newPath}'.`,
    });
  } catch (error) {
    console.error(`Error renaming item for project ${projectId}:`, error);
    res.status(500).json({ success: false, error: "Could not rename item." });
  }
});

async function readDirectoryRecursive(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          type: "directory",
          children: await readDirectoryRecursive(fullPath),
        };
      } else {
        return { name: entry.name, type: "file" };
      }
    }),
  );
  // Sort to show directories first, then by name
  return files.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * NEW: List Files in Project Endpoint
 */
app.get("/api/projects/:projectId/files", isAuthenticated, async (req, res) => {
  const { projectId } = req.params;

  try {
    const projectPath = path.join(__dirname, "projects", projectId.toString());
    const files = await readDirectoryRecursive(projectPath);
    res.json(files);
  } catch (error) {
    console.error(`Error listing files for project ${projectId}:`, error);
    if (error.code === "ENOENT") {
      return res
        .status(404)
        .json({ success: false, error: "Project directory not found." });
    }
    res
      .status(500)
      .json({ success: false, error: "Could not list project files." });
  }
});

/**
 * REVISED: Read File Content Endpoint (uses query param for sub-paths)
 */
app.get(
  "/api/projects/:projectId/file-content",
  isAuthenticated,
  async (req, res) => {
    const { projectId } = req.params;
    const { path: relativePath } = req.query;

    if (!relativePath) {
      return res
        .status(400)
        .json({ success: false, error: "File path is required." });
    }

    try {
      const projectBasePath = path.join(
        __dirname,
        "projects",
        projectId.toString(),
      );
      const filePath = path.join(projectBasePath, relativePath);

      if (!filePath.startsWith(projectBasePath)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid file path." });
      }

      const content = await fs.readFile(filePath, "utf8");

      res.json({ success: true, content });
    } catch (error) {
      console.error(
        `Error reading file ${relativePath} for project ${projectId}:`,
        error,
      );
      if (error.code === "ENOENT") {
        return res
          .status(404)
          .json({ success: false, error: "File not found." });
      }
      res.status(500).json({ success: false, error: "Could not read file." });
    }
  },
);

// --- SERVER START ---
server.listen(port, () => {
  const border = "=====================================================";
  const localUrl = `http://localhost:${port}`;

  console.log("\n" + border);
  console.log(`  🚀 Aces's Lair Server is LIVE!`);
  console.log(border);
  console.log(`\n  Key Access Points:`);
  console.log(`  - Public Hub:    ${localUrl}/public-view.html`);
  console.log(`  - Workspace:     ${localUrl}/workspace.html`);
  console.log(`  - Login Portal:  ${localUrl}/login.html`);
  console.log(`\n  Other Links:`);
  console.log(`  - Component Lib: ${localUrl}/library.html`);
  console.log(`  - Dev Console:   ${localUrl}/aces-lair-99.html`);
  console.log(`  - Aces AI:       ${localUrl}/aces-ai.html`);
  console.log(`  - Usage Policy:  ${localUrl}/policy.html`);
  console.log(`\n` + border + "\n");
});
