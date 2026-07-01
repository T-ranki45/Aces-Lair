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
const port = process.env.PORT || 3000;
const host = "0.0.0.0";

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

const FALLBACK_STORE_PATH = path.join(__dirname, "auth-store.json");
let fallbackStore = {
  users: [],
  profiles: [],
  projects: [],
  consoleAdmins: [],
  consoleMessages: [],
};

async function loadFallbackStore() {
  try {
    const raw = await fs.readFile(FALLBACK_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    fallbackStore = {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      consoleAdmins: Array.isArray(parsed.consoleAdmins)
        ? parsed.consoleAdmins
        : [],
      consoleMessages: Array.isArray(parsed.consoleMessages)
        ? parsed.consoleMessages
        : [],
    };
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      console.error("Failed to load fallback auth store:", error);
    }
    fallbackStore = {
      users: [],
      profiles: [],
      projects: [],
      consoleAdmins: [],
      consoleMessages: [],
    };
  }
}

async function saveFallbackStore() {
  try {
    await fs.writeFile(FALLBACK_STORE_PATH, JSON.stringify(fallbackStore, null, 2));
  } catch (error) {
    console.error("Failed to save fallback auth store:", error);
  }
}

function isDatabaseAvailable() {
  return mongoose.connection.readyState === 1;
}

async function createFallbackUser({ fullName, email, password }) {
  const user = {
    _id: `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    fullName,
    email,
    password,
    isBanned: false,
  };
  fallbackStore.users.push(user);
  await saveFallbackStore();
  return user;
}

async function createFallbackProfile({ userId, role, location, website, bio }) {
  const profile = {
    _id: `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    userId,
    role,
    location,
    website,
    bio,
  };
  fallbackStore.profiles.push(profile);
  await saveFallbackStore();
  return profile;
}

async function createFallbackConsoleAdmin({ username, pin }) {
  const admin = {
    _id: `console-admin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    username,
    pin,
    lastLogin: null,
  };
  fallbackStore.consoleAdmins.push(admin);
  await saveFallbackStore();
  return admin;
}

function getFallbackConsoleAdmin(username) {
  return fallbackStore.consoleAdmins.find((entry) => entry.username === username);
}

function getFallbackConsoleMessages(username) {
  return fallbackStore.consoleMessages
    .filter((entry) => entry.sender === username || entry.recipient === username)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

async function createFallbackConsoleMessage(messagePayload) {
  const message = {
    ...messagePayload,
    _id: `console-message-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: messagePayload.timestamp || new Date().toISOString(),
    read: Boolean(messagePayload.read),
  };
  fallbackStore.consoleMessages.push(message);
  await saveFallbackStore();
  return message;
}

loadFallbackStore();

// --- SOCKET.IO SETUP ---
const server = http.createServer(app);
const io = new Server(server);

// --- MIDDLEWARE ---
app.use(express.json()); // For parsing application/json
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded

const pageRoutes = {
  "/": "public-view.html",
  "/login": "login.html",
  "/signup": "signup.html",
  "/workspace": "workspace.html",
  "/public-view": "public-view.html",
  "/library": "library.html",
  "/policy": "policy.html",
  "/aces-ai": "aces-ai.html",
  "/aces-lair-99": "aces-lair-99.html",
  "/forgot-password": "forgot-password.html",
  "/reset-password": "reset-password.html",
};

Object.entries(pageRoutes).forEach(([route, fileName]) => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, fileName));
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "aces-lair" });
});

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

async function handleFallbackLogin(req, res, respondWithJson = false) {
  const { email, password } = req.body || {};

  if (!email || !password) {
    if (respondWithJson) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required.",
      });
    }

    return res.redirect("/login.html?error=Invalid%20credentials");
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = fallbackStore.users.find((entry) => entry.email === normalizedEmail);

  if (!user) {
    if (respondWithJson) {
      return res.status(401).json({
        success: false,
        error: "No account registered with this email.",
      });
    }

    return res.redirect(
      "/login.html?error=No%20account%20registered%20with%20this%20email",
    );
  }

  if (user.isBanned) {
    if (respondWithJson) {
      return res.status(403).json({
        success: false,
        error: "This account has been banned.",
      });
    }

    return res.redirect("/login.html?error=This%20account%20has%20been%20banned");
  }

  const match = await bcrypt.compare(password, user.password);
  if (match) {
    req.session.userId = user._id;
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    if (respondWithJson) {
      return res.status(200).json({
        success: true,
        message: "Login successful.",
        userId: user._id.toString(),
      });
    }

    return res.redirect("/workspace.html");
  }

  if (respondWithJson) {
    return res.status(401).json({
      success: false,
      error: "Invalid credentials.",
    });
  }

  return res.redirect("/login.html?error=Invalid%20credentials");
}

async function handleLogin(req, res, respondWithJson = false) {
  if (!isDatabaseAvailable()) {
    return handleFallbackLogin(req, res, respondWithJson);
  }

  const { email, password } = req.body || {};

  if (!email || !password) {
    if (respondWithJson) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required.",
      });
    }

    return res.redirect("/login.html?error=Invalid%20credentials");
  }

  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      if (respondWithJson) {
        return res.status(401).json({
          success: false,
          error: "No account registered with this email.",
        });
      }

      return res.redirect(
        "/login.html?error=No%20account%20registered%20with%20this%20email",
      );
    }

    if (user.isBanned) {
      if (respondWithJson) {
        return res.status(403).json({
          success: false,
          error: "This account has been banned.",
        });
      }

      return res.redirect(
        "/login.html?error=This%20account%20has%20been%20banned",
      );
    }

    const match = await bcrypt.compare(password, user.password);
    if (match) {
      req.session.userId = user._id;
      await new Promise((resolve, reject) => {
        req.session.save((err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      if (respondWithJson) {
        return res.status(200).json({
          success: true,
          message: "Login successful.",
          userId: user._id.toString(),
        });
      }

      return res.redirect("/workspace.html");
    }

    if (respondWithJson) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials.",
      });
    }

    return res.redirect("/login.html?error=Invalid%20credentials");
  } catch (error) {
    console.error("Database error during login:", error);

    if (!isDatabaseAvailable()) {
      return handleFallbackLogin(req, res, respondWithJson);
    }

    if (respondWithJson) {
      return res.status(500).json({
        success: false,
        error: "Server error during login.",
      });
    }

    return res.redirect("/login.html?error=Server%20error");
  }
}

async function handleFallbackSignup(req, res, respondWithJson = false) {
  const { fullName, email, password } = req.body || {};

  if (!fullName || !email || !password) {
    if (respondWithJson) {
      return res.status(400).json({
        success: false,
        error: "All fields are required.",
      });
    }

    return res.redirect("/signup.html?error=All%20fields%20are%20required");
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const existingUser = fallbackStore.users.find((entry) => entry.email === normalizedEmail);
  if (existingUser) {
    if (respondWithJson) {
      return res.status(409).json({
        success: false,
        error: "Email already in use.",
      });
    }

    return res.redirect("/signup.html?error=Email%20already%20in%20use");
  }

  const saltRounds = 10;
  const hashedPassword = await bcrypt.hash(password, saltRounds);
  const newUser = await createFallbackUser({
    fullName,
    email: normalizedEmail,
    password: hashedPassword,
  });
  await createFallbackProfile({
    userId: newUser._id,
    role: "New Operative",
    location: "Undisclosed",
    website: "",
    bio: "No bio yet.",
  });

  if (respondWithJson) {
    return res.status(201).json({
      success: true,
      message: "Account created successfully.",
      userId: newUser._id.toString(),
    });
  }

  return res.redirect("/login.html?success=Account%20created!%20Please%20log%20in.");
}

async function handleSignup(req, res, respondWithJson = false) {
  if (!isDatabaseAvailable()) {
    return handleFallbackSignup(req, res, respondWithJson);
  }

  const { fullName, email, password } = req.body || {};

  if (!fullName || !email || !password) {
    if (respondWithJson) {
      return res.status(400).json({
        success: false,
        error: "All fields are required.",
      });
    }

    return res.redirect("/signup.html?error=All%20fields%20are%20required");
  }

  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      if (respondWithJson) {
        return res.status(409).json({
          success: false,
          error: "Email already in use.",
        });
      }

      return res.redirect("/signup.html?error=Email%20already%20in%20use");
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newUser = new User({
      fullName,
      email: normalizedEmail,
      password: hashedPassword,
    });
    await newUser.save();

    const newProfile = new Profile({
      userId: newUser._id,
      role: "New Operative",
      location: "Undisclosed",
      website: "",
      bio: "No bio yet.",
    });
    await newProfile.save();

    if (respondWithJson) {
      return res.status(201).json({
        success: true,
        message: "Account created successfully.",
        userId: newUser._id.toString(),
      });
    }

    return res.redirect("/login.html?success=Account%20created!%20Please%20log%20in.");
  } catch (error) {
    console.error("Error during signup process:", error);

    if (!isDatabaseAvailable()) {
      return handleFallbackSignup(req, res, respondWithJson);
    }

    if (respondWithJson) {
      return res.status(500).json({
        success: false,
        error: "An unexpected error occurred while creating the account.",
      });
    }

    return res.redirect("/signup.html?error=An%20unexpected%20error%20occurred");
  }
}

// --- AUTHENTICATION ROUTES ---

app.post("/login", async (req, res) => {
  return handleLogin(req, res, false);
});

app.all("/api/login", async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Use POST to authenticate.",
    });
  }

  return handleLogin(req, res, true);
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.redirect("/workspace.html");
    }
    res.clearCookie("connect.sid");
    res.redirect("/login.html");
  });
});

// --- SIGNUP ROUTE ---
app.post("/signup", async (req, res) => {
  return handleSignup(req, res, false);
});

app.all("/api/signup", async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Use POST to create an account.",
    });
  }

  return handleSignup(req, res, true);
});

app.all("/api/register", async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Use POST to create an account.",
    });
  }

  return handleSignup(req, res, true);
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

  if (!isDatabaseAvailable()) {
    const fallbackUser = fallbackStore.users.find((entry) => entry._id === userId);
    if (!fallbackUser) {
      req.session.destroy();
      return res.status(401).json({ error: "User not found, session terminated." });
    }

    const fallbackProfile = fallbackStore.profiles.find(
      (entry) => entry.userId === userId,
    );
    const fallbackProjects = fallbackStore.projects.filter(
      (entry) => entry.userId === userId,
    );

    const skills = [
      { name: "JavaScript", level: 90, color: "var(--al-cyan)" },
      { name: "Node.js", level: 85, color: "var(--al-green)" },
      { name: "HTML/CSS", level: 95, color: "var(--al-red)" },
    ];

    return res.json({
      user: {
        _id: fallbackUser._id,
        fullName: fallbackUser.fullName,
        email: fallbackUser.email,
        isBanned: fallbackUser.isBanned,
      },
      profile: fallbackProfile || {
        role: "Operative",
        location: "CLASSIFIED",
        website: "",
        bio: "No bio available.",
      },
      projects: fallbackProjects || [],
      skills,
    });
  }

  try {
    const [user, profile, projects] = await Promise.all([
      User.findById(userId).select("-password").lean(),
      Profile.findOne({ userId: userId }).lean(),
      Project.find({ userId: userId }).sort({ _id: -1 }).lean(),
    ]);

    if (!user) {
      req.session.destroy();
      return res
        .status(401)
        .json({ error: "User not found, session terminated." });
    }

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
      },
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
  if (!isDatabaseAvailable()) {
    return res.json(fallbackStore.consoleAdmins.map((admin) => admin.username));
  }

  try {
    const admins = await ConsoleAdmin.find({}, "username").lean();
    res.json(admins.map((a) => a.username));
  } catch (err) {
    res.status(500).json([]);
  }
});

// Register a new console admin (Internal use)
app.post("/api/console/register", async (req, res) => {
  const { username, pin } = req.body || {};

  if (!username || !pin) {
    return res.json({ success: false, error: "Enter Codename & Pin" });
  }

  if (!isDatabaseAvailable()) {
    const existing = getFallbackConsoleAdmin(username);
    if (existing) {
      return res.json({ success: false, error: "Username taken" });
    }

    const hashedPin = await bcrypt.hash(pin, 10);
    await createFallbackConsoleAdmin({ username, pin: hashedPin });
    return res.json({ success: true, message: "Console Identity Created" });
  }

  try {
    const existing = await ConsoleAdmin.findOne({ username });
    if (existing) return res.json({ success: false, error: "Username taken" });

    const hashedPin = await bcrypt.hash(pin, 10);
    const newAdmin = new ConsoleAdmin({ username, pin: hashedPin });
    await newAdmin.save();
    res.json({ success: true, message: "Console Identity Created" });
  } catch (err) {
    console.error("Console registration failed:", err);
    res.json({ success: false, error: "Creation failed" });
  }
});

// Login to console identity
app.post("/api/console/login", async (req, res) => {
  const { username, pin } = req.body || {};

  if (!isDatabaseAvailable()) {
    const admin = getFallbackConsoleAdmin(username);
    if (!admin) {
      return res.json({ success: false, error: "Identity not found" });
    }

    const match = await bcrypt.compare(pin, admin.pin);
    if (match) {
      admin.lastLogin = new Date();
      await saveFallbackStore();
      const messages = getFallbackConsoleMessages(username);
      return res.json({ success: true, username: admin.username, messages });
    }

    return res.json({ success: false, error: "Invalid PIN" });
  }

  try {
    const admin = await ConsoleAdmin.findOne({ username });
    if (!admin) {
      return res.json({ success: false, error: "Identity not found" });
    }

    const match = await bcrypt.compare(pin, admin.pin);
    if (match) {
      admin.lastLogin = new Date();
      await admin.save();

      const messages = await ConsoleMessage.find({
        $or: [{ recipient: username }, { sender: username }],
      }).sort({ timestamp: 1 });
      res.json({ success: true, username: admin.username, messages: messages });
    } else {
      res.json({ success: false, error: "Invalid PIN" });
    }
  } catch (err) {
    console.error("Console login failed:", err);
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
server.listen(port, host, () => {
  const border = "=====================================================";
  const localUrl = `http://localhost:${port}`;
  const publicUrl = process.env.RENDER_EXTERNAL_URL || localUrl;

  console.log("\n" + border);
  console.log(`  🚀 Aces's Lair Server is LIVE!`);
  console.log(border);
  console.log(`\n  Key Access Points:`);
  console.log(`  - Public Hub:    ${publicUrl}/public-view.html`);
  console.log(`  - Workspace:     ${publicUrl}/workspace.html`);
  console.log(`  - Login Portal:  ${publicUrl}/login.html`);
  console.log(`\n  Other Links:`);
  console.log(`  - Component Lib: ${publicUrl}/library.html`);
  console.log(`  - Dev Console:   ${publicUrl}/aces-lair-99.html`);
  console.log(`  - Aces AI:       ${publicUrl}/aces-ai.html`);
  console.log(`  - Usage Policy:  ${publicUrl}/policy.html`);
  console.log(`\n` + border + "\n");
});
