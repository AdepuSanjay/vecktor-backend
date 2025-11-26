// server.js  (single-file server - signup/signin with Gmail OTP, sessions, chat history + analysis)
// Run: node server.js
import express from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fetch from "node-fetch";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Allowed origins
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://vektor-insight.vercel.app",
  "https://studymate-swart.vercel.app",
];
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

// ------------------- MONGOOSE -------------------
mongoose
  .connect(process.env.MONGO_URI || "mongodb+srv://Abcd:123@cluster0.lc6c1xt.mongodb.net/study")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

// Simple User and Chat Schemas (single file)
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String, // plain text as requested (insecure - consider hashing later)
  sessionToken: String, // active session token (simple)
  createdAt: { type: Date, default: Date.now },
});
const User = mongoose.model("User", userSchema);

const chatSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false }, // null = anonymous
  sessionId: String, // for anonymous session tracking
  messages: [
    {
      role: String, // 'user' | 'assistant' | 'system'
      text: String,
      meta: Object,
      createdAt: { type: Date, default: Date.now },
    },
  ],
  createdAt: { type: Date, default: Date.now },
});
const Chat = mongoose.model("Chat", chatSchema);

// ------------------- Mailer (Gmail App Password configured inline per request) -------------------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "adepusanjay444@gmail.com",
    pass: "lrnesuqvssiognej", // App Password (you provided it)
  },
});

// ------------------- TEMP STORAGE -------------------
// Temporary OTP store: { email: { otp, expiresAt, name, password } }
const tempOtps = new Map();

// Anonymous in-memory chats keyed by sessionId (ephemeral)
const anonChats = new Map();

// ------------------- PATHS -------------------
const BASE_TMP = "/tmp";
const UPLOADS_PATH = path.join(BASE_TMP, "uploads");
const EXTRACTED_PATH = path.join(BASE_TMP, "extracted");
const REPOS_PATH = path.join(BASE_TMP, "repos");
[UPLOADS_PATH, EXTRACTED_PATH, REPOS_PATH].forEach((p) => fs.mkdirSync(p, { recursive: true }));

// ------------------- MULTER -------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_PATH);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

// ------------------- HELPERS -------------------
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeOTP() {
  return (Math.floor(100000 + Math.random() * 900000)).toString(); // 6-digit
}

function makeToken() {
  return crypto.randomBytes(28).toString("hex");
}

function nowPlusMinutes(min) {
  return Date.now() + min * 60 * 1000;
}

// (existing helpers from your file)
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
  const ignoreDirs = [".git", "node_modules", "vendor", "dist", "build", "pycache", "__pycache__"];
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
              language: isDependencyFile(fullPath) ? "dependency" : detectLanguage(fullPath),
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

// ------------------- SSE (unchanged) -------------------
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

// ------------------- GEMINI CALL (same as yours) -------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyCk3VyHVj3_UMqtHlN5NhbS5pv9yMHDSTs";

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
Code:
${codeContent}
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

// ------------------- ANALYSIS (unchanged but wired to save chat) -------------------
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

// ------------------- AUTH HELPERS & MIDDLEWARE -------------------

// Authenticate by session token header 'x-session-token'
async function authMiddleware(req, res, next) {
  const token = req.headers["x-session-token"];
  if (!token) {
    req.user = null;
    return next();
  }
  const user = await User.findOne({ sessionToken: token });
  if (!user) {
    req.user = null;
    return next();
  }
  req.user = user;
  next();
}

app.use(express.json());
app.use(express.static("public"));
app.use(authMiddleware);

// ------------------- AUTH ROUTES (OTP-based) -------------------

// 1) Signup request: generate OTP and email it. Body: { name, email, password }
app.post("/auth/signup/request", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });

    // If user already exists -> return error
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: "Email already registered" });

    const otp = makeOTP();
    const expiresAt = nowPlusMinutes(10); // 10 minutes

    tempOtps.set(email, { otp, expiresAt, name, password });

    // send mail
    await transporter.sendMail({
      to: email,
      subject: "Your signup OTP",
      text: `Your signup OTP is: ${otp}. It expires in 10 minutes.`,
    });

    return res.json({ success: true, message: "OTP sent to email" });
  } catch (err) {
    console.error("Signup request error:", err);
    res.status(500).json({ error: "Unable to send OTP" });
  }
});

// 2) Signup verify: Body { email, otp } -> create user
app.post("/auth/signup/verify", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: "Missing fields" });

    const record = tempOtps.get(email);
    if (!record) return res.status(400).json({ error: "No OTP request found" });
    if (Date.now() > record.expiresAt) {
      tempOtps.delete(email);
      return res.status(400).json({ error: "OTP expired" });
    }
    if (record.otp !== otp) return res.status(400).json({ error: "Invalid OTP" });

    // create user
    const user = new User({
      name: record.name,
      email,
      password: record.password, // plain text per request
      sessionToken: makeToken(),
    });
    await user.save();
    tempOtps.delete(email);

    return res.json({ success: true, token: user.sessionToken, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("Signup verify error:", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

// 3) Signin request: Body { email, password } -> verify credentials then send OTP for signin
app.post("/auth/signin/request", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });
    if (user.password !== password) return res.status(400).json({ error: "Invalid password" });

    const otp = makeOTP();
    const expiresAt = nowPlusMinutes(10);

    tempOtps.set(email, { otp, expiresAt, signin: true }); // signin marker

    await transporter.sendMail({
      to: email,
      subject: "Your signin OTP",
      text: `Your signin OTP is: ${otp}. It expires in 10 minutes.`,
    });

    return res.json({ success: true, message: "Signin OTP sent" });
  } catch (err) {
    console.error("Signin request error:", err);
    res.status(500).json({ error: "Unable to send OTP" });
  }
});

// 4) Signin verify: Body { email, otp } -> issue session token
app.post("/auth/signin/verify", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: "Missing fields" });

    const record = tempOtps.get(email);
    if (!record || !record.signin) return res.status(400).json({ error: "No signin OTP found" });
    if (Date.now() > record.expiresAt) {
      tempOtps.delete(email);
      return res.status(400).json({ error: "OTP expired" });
    }
    if (record.otp !== otp) return res.status(400).json({ error: "Invalid OTP" });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });

    user.sessionToken = makeToken();
    await user.save();

    tempOtps.delete(email);
    return res.json({ success: true, token: user.sessionToken, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("Signin verify error:", err);
    res.status(500).json({ error: "Signin failed" });
  }
});

// Signout
app.post("/auth/signout", async (req, res) => {
  try {
    const token = req.headers["x-session-token"];
    if (!token) return res.status(400).json({ error: "Missing token" });
    const user = await User.findOne({ sessionToken: token });
    if (!user) return res.status(400).json({ error: "Invalid token" });
    user.sessionToken = null;
    await user.save();
    return res.json({ success: true });
  } catch (err) {
    console.error("Signout error:", err);
    res.status(500).json({ error: "Signout failed" });
  }
});

// ------------------- CHAT HISTORY ROUTES -------------------

// Create or append a chat message (user sends message) and optionally get assistant response saved.
// Body: { sessionId (optional for anonymous), text, meta (optional) }
// If authenticated (x-session-token header), will store under user._id
app.post("/chat/message", async (req, res) => {
  try {
    const { sessionId, text, meta } = req.body;
    if (!text) return res.status(400).json({ error: "No text provided" });

    let chatDoc = null;
    if (req.user) {
      // find or create chat for user
      chatDoc = await Chat.findOne({ userId: req.user._id });
      if (!chatDoc) {
        chatDoc = new Chat({ userId: req.user._id, messages: [] });
      }
    } else {
      // anonymous: must have or get a sessionId from client. If none provided, create one and return to client.
      let sid = sessionId;
      if (!sid) {
        sid = makeToken();
      }
      // keep ephemeral in-memory chat list, and also persist a little to DB if desired (here we store in DB with sessionId)
      chatDoc = await Chat.findOne({ sessionId: sid });
      if (!chatDoc) {
        chatDoc = new Chat({ sessionId: sid, messages: [] });
      }
      // ensure client knows sessionId
      req.sessionId = sid;
    }

    // append user's message
    chatDoc.messages.push({ role: "user", text, meta: meta || {}, createdAt: new Date() });
    await chatDoc.save();

    // NOTE: You can call Gemini/OpenAI here to generate assistant reply. For now we'll do a minimal assistant reply:
    // We'll call callGeminiAPI as a "chat helper" only if needed. For demonstration, make a simple echo response.
    const assistantText = `Received your message (${text.length} chars). Use /api/analyze endpoints to analyze code/files.`;

    chatDoc.messages.push({ role: "assistant", text: assistantText, meta: { generated: true }, createdAt: new Date() });
    await chatDoc.save();

    const resp = { success: true, assistant: assistantText };
    if (!req.user) resp.sessionId = req.sessionId || sessionId;
    res.json(resp);
  } catch (err) {
    console.error("chat/message error:", err);
    res.status(500).json({ error: "Chat failed" });
  }
});

// Get chat history for authenticated user or anonymous session.
// Query param: ?sessionId=xxx  (for anonymous)
app.get("/chat/history", async (req, res) => {
  try {
    if (req.user) {
      const chats = await Chat.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50);
      return res.json({ success: true, chats });
    }
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: "No sessionId provided for anonymous user" });
    const chat = await Chat.findOne({ sessionId });
    return res.json({ success: true, chats: chat ? [chat] : [] });
  } catch (err) {
    console.error("chat/history error:", err);
    res.status(500).json({ error: "Failed to fetch chats" });
  }
});

// ------------------- UPLOAD & ANALYZE (w/ chat saving) -------------------

// Upload only
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

// Analyze uploaded folder (store analysis in chat history)
app.post("/api/analyze/:uploadId", async (req, res) => {
  try {
    const { uploadId } = req.params;
    const extractPath = path.join(EXTRACTED_PATH, uploadId);

    if (!fs.existsSync(extractPath)) {
      return res.status(400).json({ error: "Upload not found" });
    }

    const files = readCodeFiles(extractPath);
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });

    const aiResponse = await analyzeFiles(files);

    // Save analysis as chat message
    let chatDoc;
    if (req.user) {
      chatDoc = await Chat.findOne({ userId: req.user._id });
      if (!chatDoc) chatDoc = new Chat({ userId: req.user._id, messages: [] });
    } else {
      const sessionId = req.body.sessionId || req.query.sessionId;
      if (!sessionId) {
        // create ephemeral sessionId and send to client
        const sid = makeToken();
        chatDoc = new Chat({ sessionId: sid, messages: [] });
      } else {
        chatDoc = await Chat.findOne({ sessionId }) || new Chat({ sessionId, messages: [] });
      }
    }

    chatDoc.messages.push({
      role: "assistant",
      text: "Analysis results",
      meta: { analysis: aiResponse },
      createdAt: new Date(),
    });
    await chatDoc.save();

    res.json({ success: true, analysis: aiResponse });
  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({ error: "Analysis failed" });
  }
});

// Upload & analyze directly (store in chat)
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

    // Save analysis as chat message
    let chatDoc;
    if (req.user) {
      chatDoc = await Chat.findOne({ userId: req.user._id });
      if (!chatDoc) chatDoc = new Chat({ userId: req.user._id, messages: [] });
    } else {
      const sessionId = req.body.sessionId;
      if (!sessionId) {
        const sid = makeToken();
        chatDoc = new Chat({ sessionId: sid, messages: [] });
      } else {
        chatDoc = await Chat.findOne({ sessionId }) || new Chat({ sessionId, messages: [] });
      }
    }

    chatDoc.messages.push({
      role: "assistant",
      text: "Analysis results",
      meta: { analysis: aiResponse },
      createdAt: new Date(),
    });
    await chatDoc.save();

    res.json({ success: true, analysis: aiResponse });
  } catch (error) {
    console.error("Upload analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------- GITHUB ZIP ANALYSIS (unchanged but chat-saved) -------------------
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

    // Save to chat
    let chatDoc;
    if (req.user) {
      chatDoc = await Chat.findOne({ userId: req.user._id }) || new Chat({ userId: req.user._id, messages: [] });
    } else {
      const sessionId = req.body.sessionId;
      chatDoc = (sessionId && (await Chat.findOne({ sessionId }))) || new Chat({ sessionId, messages: [] });
      if (!chatDoc) chatDoc = new Chat({ sessionId, messages: [] });
    }
    chatDoc.messages.push({ role: "assistant", text: "GitHub analysis results", meta: { analysis: aiResponse }, createdAt: new Date() });
    await chatDoc.save();

    res.json({ success: true, analysis: aiResponse });
  } catch (error) {
    console.error("GitHub analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Health check
app.get("/health", (req, res) => res.json({ status: "OK", message: "Server running" }));

// Start server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));