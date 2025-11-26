// server.mjs
// Single-file Express server with:
// - MongoDB (mongoose) connection
// - Gmail App Password mailer (OTP sign-up)
// - Signup (OTP) / Signin (password) with JWT
// - Anonymous chat (ephemeral, not stored)
// - Chat history storing and retrieval for signed-in users
// - File upload + repository download + code analysis using your Gemini call
// - File upload and analyze endpoints
// - SSE progress broadcasting for analysis
//
// NOTE: This file intentionally inlines credentials (no .env) as requested.
// Be careful with sharing this file publicly.

import express from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------- CONFIG (no .env as requested) -------------------
// MongoDB connection string (you provided earlier)
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://Abcd:123@cluster0.lc6c1xt.mongodb.net/study";

// Gmail credentials (App Password)
const MAIL_USER = "adepusanjay444@gmail.com";
const MAIL_PASS = "lrnesuqvssiognej"; // App password you provided

// JWT secret (since no env, keep here)
const JWT_SECRET = "super-secret-key-no-env"; // change if you want

// Gemini API key
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "AIzaSyCk3VyHVj3_UMqtHlN5NhbS5pv9yMHDSTs";

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://vektor-insight.vercel.app",
  "https://studymate-swart.vercel.app",
];

// ------------------- MONGOOSE SETUP -------------------
mongoose
  .connect(MONGO_URI, { autoIndex: true })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

// Schemas
const UserSchema = new mongoose.Schema(
  {
    name: String,
    email: { type: String, unique: true, index: true },
    passwordHash: String, // bcrypt hash
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const ChatMessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant", "system"], default: "user" },
    content: String,
    createdAt: { type: Date, default: Date.now },
    // optionally link to analysis results or files
    meta: mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const ChatSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    title: String,
    messages: [ChatMessageSchema],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    // analyze results or uploaded file refs
    files: [mongoose.Schema.Types.Mixed],
  },
  { timestamps: true }
);

const User = mongoose.model("User", UserSchema);
const Chat = mongoose.model("Chat", ChatSchema);

// ------------------- MAILER (Gmail App Password) -------------------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: MAIL_USER,
    pass: MAIL_PASS,
  },
});

// ------------------- STORAGE & UPLOADS -------------------
const BASE_TMP = "/tmp";
const UPLOADS_PATH = path.join(BASE_TMP, "uploads");
const EXTRACTED_PATH = path.join(BASE_TMP, "extracted");
const REPOS_PATH = path.join(BASE_TMP, "repos");
[UPLOADS_PATH, EXTRACTED_PATH, REPOS_PATH].forEach((p) =>
  fs.mkdirSync(p, { recursive: true })
);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_PATH);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

// ------------------- CORS & MIDDLEWARE -------------------
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(express.static("public"));

// ------------------- HELPERS (from your file, lightly adapted) -------------------
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LANGUAGE_EXTENSIONS = {
  python: [".py"],
  javascript: [".js", ".jsx"],
  typescript: [".ts", ".tsx"],
  java: [".java"],
  c: [".c"],
  cpp: [".cpp", ".cc", ".cxx", ".c++"],
  php: [".php"],
};

const DEPENDENCY_FILES = [
  "package.json",
  "requirements.txt",
  "Pipfile",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "go.mod",
  "go.sum",
];

const IGNORE_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];

function detectLanguage(filename) {
  const ext = path.extname(filename).toLowerCase();
  for (const [lang, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (extensions.includes(ext)) return lang;
  }
  return "unknown";
}

function isCodeFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (IGNORE_EXTENSIONS.includes(ext)) {
    return false;
  }
  return Object.values(LANGUAGE_EXTENSIONS).flat().includes(ext);
}

function isDependencyFile(filename) {
  return DEPENDENCY_FILES.includes(path.basename(filename));
}

function shouldIgnoreFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return IGNORE_EXTENSIONS.includes(ext);
}

function readCodeFiles(dirPath) {
  const files = [];
  const ignoreDirs = [
    ".git",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "pycache",
    "__pycache__",
  ];
  const ignoreFiles = [".DS_Store", "Thumbs.db"];

  function readRecursive(currentPath) {
    const items = fs.readdirSync(currentPath);
    for (const item of items) {
      if (ignoreDirs.includes(item)) continue;

      const fullPath = path.join(currentPath, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        readRecursive(fullPath);
      } else if (stat.isFile() && !ignoreFiles.includes(item)) {
        if (shouldIgnoreFile(fullPath)) {
          continue;
        }

        if (isCodeFile(fullPath) || isDependencyFile(fullPath)) {
          try {
            const content = fs.readFileSync(fullPath, "utf8");
            files.push({
              path: fullPath,
              content,
              language: isDependencyFile(fullPath)
                ? "dependency"
                : detectLanguage(fullPath),
            });
          } catch {
            console.log(`Skipping file: ${fullPath}`);
          }
        }
      }
    }
  }

  readRecursive(dirPath);
  return files;
}

// ------------------- SSE (progress) -------------------
let clients = [];
app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.push(res);
  req.on("close", () => {
    clients = clients.filter((c) => c !== res);
  });
});

function broadcast(event, data) {
  clients.forEach((res) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// ------------------- Gemini / AI CALL -------------------
async function callGeminiAPI(codeContent, language, retries = 3) {
  const prompt = `
You are an expert code analyzer for ${language}.
Check for: syntax errors, dependency issues, duplicate code, security risks, performance problems, and best practice violations.
Return ONLY valid JSON like this:

{
  "issues": [
    { "line": 10, "type": "syntax_error", "message": "Issue description", "suggestion": "Suggested fix" }
  ]
}

Types: syntax_error, dependency, duplicate, security, performance, best_practice
Code:\n${codeContent}
`;

  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );

      if (response.status === 429) {
        await delay(2000 * (i + 1));
        continue;
      }

      if (!response.ok) throw new Error(`Gemini API error: ${response.statusText}`);

      const data = await response.json();
      let text = data.candidates[0].content.parts[0].text.trim();

      if (text.startsWith("```json")) {
        text = text.slice(7);
      }
      if (text.endsWith("```")) {
        text = text.slice(0, -3);
      }
      text = text.replace(/```/g, "").trim();

      return JSON.parse(text);
    } catch (err) {
      console.error(`Gemini API attempt ${i + 1} failed:`, err.message);
      if (i === retries - 1) {
        return {
          issues: [{ line: 0, type: "error", message: err.message, suggestion: "Check API call" }],
        };
      }
    }
  }
}

// ------------------- ANALYSIS -------------------
async function analyzeFiles(files) {
  const results = [];
  const total = files.length;

  if (total === 0) {
    return results;
  }

  broadcast("progress", { message: `📑 Starting analysis of ${total} files`, progress: 0 });

  for (let i = 0; i < total; i++) {
    const file = files[i];
    const progress = (((i + 1) / total) * 100).toFixed(1);

    broadcast("progress", {
      message: `🔍 [${i + 1}/${total}] (${progress}%) Analyzing ${path.basename(file.path)}`,
      progress,
    });

    let issues = [];

    try {
      const aiResult = await callGeminiAPI(file.content, file.language);
      if (aiResult && aiResult.issues) {
        broadcast("progress", {
          message: `✅ Analyzed ${path.basename(file.path)}, found ${aiResult.issues.length} issues`,
          progress,
        });
        issues = aiResult.issues;
      }
    } catch (error) {
      console.error(`Error analyzing ${file.path}:`, error);
      issues = [{ line: 0, type: "error", message: "Analysis failed", suggestion: "Try again" }];
    }

    results.push({
      file: file.path,
      language: file.language,
      issues,
    });

    await delay(1000);
  }

  broadcast("end", { message: "🚀 Analysis complete." });
  return results;
}

// ------------------- GITHUB DOWNLOAD -------------------
async function downloadRepoZip(repoUrl, extractPath, token = null) {
  try {
    const match = repoUrl.match(/github.com\/([^\/]+)\/([^\/]+)(?:\.git)?/);
    if (!match) throw new Error("Invalid GitHub URL");

    const owner = match[1];
    const repo = match[2];

    const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/main`;

    const headers = {
      "User-Agent": "Vektor-Insight",
      Accept: "application/vnd.github.v3+json",
    };
    if (token) headers["Authorization"] = `token ${token}`;

    const response = await fetch(zipUrl, { headers });
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const zipPath = path.join(extractPath, "repo.zip");
    fs.writeFileSync(zipPath, buffer);

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    return true;
  } catch (err) {
    console.error("Error downloading repo ZIP:", err.message);
    return false;
  }
}

// ------------------- AUTH: OTP + SIGNIN -------------------

// In-memory OTP store: { email => { otp, name, passwordHash, expiresAt } }
// We store passwordHash on initial step because user enters name/email/password then we send OTP
const otpStore = new Map();

// Helper: send OTP email
async function sendOTPEmail(email, otp) {
  const mailOptions = {
    from: `StudyMate <${MAIL_USER}>`,
    to: email,
    subject: "Your StudyMate signup OTP",
    text: `Your OTP for signup: ${otp}\nIt expires in 5 minutes.`,
  };
  return transporter.sendMail(mailOptions);
}

// Generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Hash utility
async function hashPassword(plain) {
  const saltRounds = 10;
  return bcrypt.hash(plain, saltRounds);
}

// JWT utilities
function signJwt(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

function verifyJwt(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Auth middleware
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const data = verifyJwt(token);
  if (!data || !data.id) return res.status(401).json({ error: "Invalid token" });
  req.userId = data.id;
  next();
}

// ------------------- ROUTES: AUTH -------------------

// Step 1: send OTP (user provides name, email, password)
app.post("/auth/send-otp", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email, password required" });
    }

    // check if user exists already
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: "User already exists. Please sign in." });
    }

    const otp = generateOTP();
    const passwordHash = await hashPassword(password);

    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    otpStore.set(email, { otp, name, passwordHash, expiresAt });

    // send email
    try {
      await sendOTPEmail(email, otp);
      return res.json({ ok: true, message: "OTP sent to email (valid 5 minutes)" });
    } catch (err) {
      console.error("Failed to send OTP email:", err);
      return res.status(500).json({ error: "Failed to send OTP email" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Step 2: verify OTP and create user
app.post("/auth/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: "email and otp required" });

    const record = otpStore.get(email);
    if (!record) return res.status(400).json({ error: "No OTP requested for this email" });

    if (Date.now() > record.expiresAt) {
      otpStore.delete(email);
      return res.status(400).json({ error: "OTP expired" });
    }
    if (record.otp !== String(otp)) return res.status(400).json({ error: "Invalid OTP" });

    // Create user
    const user = new User({
      name: record.name,
      email,
      passwordHash: record.passwordHash,
    });
    await user.save();

    // cleanup otp
    otpStore.delete(email);

    // return jwt
    const token = signJwt({ id: user._id, email: user.email });
    res.json({ ok: true, token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("verify-otp error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Signin: email + password
app.post("/auth/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "email and password required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ error: "Invalid credentials" });

    const token = signJwt({ id: user._id, email: user.email });
    res.json({ ok: true, token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------- CHAT: send message / history -------------------

// Send a chat message (and optionally save to DB if authenticated).
// Body: { message: "text", anon: boolean (optional), chatId: string (optional) }
// If anon=true or no token provided -> ephemeral (not stored).
app.post("/chat/send", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userData = token ? verifyJwt(token) : null;

    const { message, anon = false, chatId } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });

    // Here you'd call your chat model / logic. For now we simulate AI assistant reply
    // Optionally you could call Gemini / other model for actual responses. We'll return a simple echo + analysis placeholder.

    // Example: analyze the message for code blocks (very naive)
    const containsCode = /```[\s\S]*?```/.test(message) || /function\s+\w+\(/.test(message);
    const assistantReply = containsCode
      ? `I detected code in your message. You can use /api/analyze/code or upload files for in-depth analysis.`
      : `Assistant reply: ${message}`;

    const msgUser = { role: "user", content: message, createdAt: new Date() };
    const msgAssistant = { role: "assistant", content: assistantReply, createdAt: new Date() };

    // If anonymous or not authenticated -> don't save, just return ephemeral exchange
    if (anon || !userData) {
      return res.json({
        ok: true,
        saved: false,
        conversation: [msgUser, msgAssistant],
      });
    }

    // Authenticated: store into a chat document (create new or append)
    const userId = userData.id;
    let chat;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, userId });
    }

    if (!chat) {
      chat = new Chat({
        userId,
        title: message.slice(0, 60),
        messages: [msgUser, msgAssistant],
        files: [],
      });
    } else {
      chat.messages.push(msgUser);
      chat.messages.push(msgAssistant);
      chat.updatedAt = new Date();
    }
    await chat.save();

    res.json({
      ok: true,
      saved: true,
      chatId: chat._id,
      conversation: [msgUser, msgAssistant],
    });
  } catch (err) {
    console.error("/chat/send error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get chat history for authenticated user (list chats)
app.get("/chat/history", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const chats = await Chat.find({ userId }).sort({ updatedAt: -1 }).limit(100);
    res.json({ ok: true, chats });
  } catch (err) {
    console.error("chat/history error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get single chat by id (must belong to user)
app.get("/chat/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const chat = await Chat.findOne({ _id: req.params.id, userId });
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    res.json({ ok: true, chat });
  } catch (err) {
    console.error("chat/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Clear a user's chats
app.delete("/chat/clear", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    await Chat.deleteMany({ userId });
    res.json({ ok: true, message: "All chats cleared" });
  } catch (err) {
    console.error("chat/clear error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------- ANALYSIS & UPLOAD ENDPOINTS -------------------
// These reuse your logic. If a request is authenticated -> results are stored in the user's chat record.
// Otherwise they run but do not persist (anon usage).

// Analyze direct code snippet
app.post("/api/analyze/code", async (req, res) => {
  try {
    const { code, filename = "code.txt", saveToChat = false, chatId = null } = req.body;
    if (!code) return res.status(400).json({ error: "No code provided" });

    const language = detectLanguage(filename);
    const aiResponse = await callGeminiAPI(code, language !== "unknown" ? language : "javascript");

    // If user is authenticated and saveToChat true -> append to chat
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userData = token ? verifyJwt(token) : null;

    if (userData && saveToChat) {
      const userId = userData.id;
      let chat = null;
      if (chatId) chat = await Chat.findOne({ _id: chatId, userId });
      if (!chat) {
        chat = new Chat({
          userId,
          title: filename,
          messages: [
            { role: "user", content: `Analyze code: ${filename}`, createdAt: new Date() },
            { role: "assistant", content: JSON.stringify(aiResponse, null, 2), createdAt: new Date(), meta: { filename } },
          ],
          files: [],
        });
      } else {
        chat.messages.push({ role: "user", content: `Analyze code: ${filename}`, createdAt: new Date() });
        chat.messages.push({ role: "assistant", content: JSON.stringify(aiResponse, null, 2), createdAt: new Date(), meta: { filename } });
        chat.updatedAt = new Date();
      }
      await chat.save();
      return res.json({ ok: true, saved: true, aiResponse, chatId: chat._id });
    }

    res.json({ ok: true, saved: false, aiResponse });
  } catch (error) {
    console.error("Code analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Upload files (store files temporarily) - returns uploadId
app.post("/api/upload", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const uploadId = Date.now().toString();
    const extractPath = path.join(EXTRACTED_PATH, uploadId);
    fs.mkdirSync(extractPath, { recursive: true });

    for (const file of req.files) {
      const dest = path.join(extractPath, file.originalname);
      fs.renameSync(file.path, dest);
    }

    res.json({ success: true, uploadId });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Analyze uploaded folder (by uploadId) - if authenticated, saved to user's chat if saveToChat true
app.post("/api/analyze/:uploadId", async (req, res) => {
  try {
    const { uploadId } = req.params;
    const { saveToChat = false, chatId = null } = req.body;
    const extractPath = path.join(EXTRACTED_PATH, uploadId);

    if (!fs.existsSync(extractPath)) {
      return res.status(400).json({ error: "Upload not found" });
    }

    const files = readCodeFiles(extractPath);
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });

    const aiResponse = await analyzeFiles(files);

    // If authenticated and saveToChat -> save result summary
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userData = token ? verifyJwt(token) : null;

    if (userData && saveToChat) {
      const userId = userData.id;
      let chat = null;
      if (chatId) chat = await Chat.findOne({ _id: chatId, userId });
      const summary = { uploadId, fileCount: files.length, analyzedAt: new Date() };
      if (!chat) {
        chat = new Chat({
          userId,
          title: `Analysis ${new Date().toISOString()}`,
          messages: [
            { role: "user", content: `Uploaded files: ${uploadId}`, createdAt: new Date() },
            { role: "assistant", content: "Analysis results attached", createdAt: new Date(), meta: { summary } },
          ],
          files: aiResponse,
        });
      } else {
        chat.messages.push({ role: "user", content: `Uploaded files: ${uploadId}`, createdAt: new Date() });
        chat.messages.push({ role: "assistant", content: "Analysis results attached", createdAt: new Date(), meta: { summary } });
        chat.files = chat.files.concat(aiResponse);
        chat.updatedAt = new Date();
      }
      await chat.save();
      return res.json({ ok: true, saved: true, aiResponse, chatId: chat._id });
    }

    res.json({ ok: true, saved: false, aiResponse });
  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({ error: "Analysis failed" });
  }
});

// Upload & analyze directly (upload + analyze in one)
app.post("/api/analyze/upload", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const extractPath = path.join(EXTRACTED_PATH, Date.now().toString());
    fs.mkdirSync(extractPath, { recursive: true });

    for (const file of req.files) {
      const dest = path.join(extractPath, file.originalname);
      fs.renameSync(file.path, dest);
    }

    const files = readCodeFiles(extractPath);
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });

    const aiResponse = await analyzeFiles(files);

    // Save summary if authenticated & requested via header
    const saveToChatHeader = (req.headers["x-save-to-chat"] || "").toString().toLowerCase();
    const saveToChat = saveToChatHeader === "true";

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userData = token ? verifyJwt(token) : null;

    if (userData && saveToChat) {
      const userId = userData.id;
      const chat = new Chat({
        userId,
        title: `Upload Analysis ${new Date().toISOString()}`,
        messages: [
          { role: "user", content: `Uploaded files`, createdAt: new Date() },
          { role: "assistant", content: "Analysis results attached", createdAt: new Date() },
        ],
        files: aiResponse,
      });
      await chat.save();
      return res.json({ ok: true, saved: true, aiResponse, chatId: chat._id });
    }

    res.json({ ok: true, saved: false, aiResponse });
  } catch (error) {
    console.error("Upload analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GitHub repo analysis
app.post("/analyze/github", async (req, res) => {
  try {
    const { repoUrl, token } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "Repository URL is required" });

    const repoPath = path.join(REPOS_PATH, Date.now().toString());
    fs.mkdirSync(repoPath, { recursive: true });

    if (!(await downloadRepoZip(repoUrl, repoPath, token))) {
      return res.status(500).json({ error: "Failed to download repo" });
    }

    const subDirs = fs
      .readdirSync(repoPath)
      .filter((item) => !item.endsWith(".zip") && fs.statSync(path.join(repoPath, item)).isDirectory());

    if (subDirs.length === 0) {
      return res.status(500).json({ error: "No extracted content found" });
    }

    const extractedRoot = path.join(repoPath, subDirs[0]);
    const files = readCodeFiles(extractedRoot);
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });

    const aiResponse = await analyzeFiles(files);

    // Save if authenticated and requested via header
    const saveToChatHeader = (req.headers["x-save-to-chat"] || "").toString().toLowerCase();
    const saveToChat = saveToChatHeader === "true";
    const authHeader = req.headers.authorization || "";
    const tkn = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const userData = tkn ? verifyJwt(tkn) : null;

    if (userData && saveToChat) {
      const userId = userData.id;
      const chat = new Chat({
        userId,
        title: `GitHub Analysis ${repoUrl}`,
        messages: [
          { role: "user", content: `Analyze repo: ${repoUrl}`, createdAt: new Date() },
          { role: "assistant", content: "Analysis results attached", createdAt: new Date() },
        ],
        files: aiResponse,
      });
      await chat.save();
      return res.json({ ok: true, saved: true, aiResponse, chatId: chat._id });
    }

    res.json({ ok: true, saved: false, aiResponse });
  } catch (error) {
    console.error("GitHub analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Health check
app.get("/health", (req, res) => res.json({ status: "OK", message: "Server running" }));

// Start server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));