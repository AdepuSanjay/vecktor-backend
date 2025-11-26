// server.js (single file)
// Run: npm i express mongoose multer adm-zip nodemailer cors bcrypt jsonwebtoken node-fetch
// Then: node server.js

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
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

/* ----------------- MongoDB ----------------- */
// NOTE: You said "No env" — using inline URI (not recommended for production)
mongoose
  .connect(
    process.env.MONGO_URI ||
      "mongodb+srv://Abcd:123@cluster0.lc6c1xt.mongodb.net/study"
  )
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

/* ----------------- Models ----------------- */
const { Schema } = mongoose;

const UserSchema = new Schema(
  {
    name: String,
    email: { type: String, unique: true, index: true },
    password: String, // hashed
    verified: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
const User = mongoose.model("User", UserSchema);

const OTPSchema = new Schema({
  email: { type: String, index: true },
  code: String,
  expiresAt: Date,
});
const OTP = mongoose.model("OTP", OTPSchema);

const ChatSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User" },
  messages: [
    {
      role: { type: String, enum: ["user", "assistant", "system"], default: "user" },
      text: String,
      files: [String], // file paths or uploadIds
      timestamp: { type: Date, default: Date.now },
    },
  ],
  createdAt: { type: Date, default: Date.now },
});
const Chat = mongoose.model("Chat", ChatSchema);

const AnalysisSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User" },
  uploadId: String,
  files: [
    {
      path: String,
      language: String,
      issues: Array,
    },
  ],
  createdAt: { type: Date, default: Date.now },
});
const Analysis = mongoose.model("Analysis", AnalysisSchema);

/* ----------------- Mailer (Gmail App Password) ----------------- */
// Using credentials you supplied; change for production.
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "adepusanjay444@gmail.com",
    pass: "lrnesuqvssiognej", // App Password (INSECURE inline for demo)
  },
});

/* ----------------- JWT secret (inline because "No env") ----------------- */
const JWT_SECRET = "SUPER_SECRET_FOR_TESTING_ONLY_please_change";

/* ----------------- CORS ----------------- */
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
app.use(express.json());
app.use(express.static("public"));

/* ----------------- Paths & Multer ----------------- */
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

/* ----------------- Language/constants/helpers from your file ----------------- */
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "AIzaSyCk3VyHVj3_UMqtHlN5NhbS5pv9yMHDSTs";

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
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (e) {
        continue;
      }

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

/* ----------------- SSE (progress) ----------------- */
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

/* ----------------- Gemini call (kept as-is) ----------------- */
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

/* ----------------- analyzeFiles (kept) ----------------- */
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

/* ----------------- Helper: downloadRepoZip ----------------- */
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

/* ----------------- AUTH HELPERS ----------------- */
async function sendOTPEmail(email, code) {
  const mailOptions = {
    from: `"Vektor Insight" <adepusanjay444@gmail.com>`,
    to: email,
    subject: "Your OTP for Vektor Insight",
    text: `Your OTP is ${code}. It is valid for 10 minutes.`,
  };

  return transporter.sendMail(mailOptions);
}

function generateOTP() {
  // 6-digit numeric
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function signToken(user) {
  return jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "No token" });
  const parts = auth.split(" ");
  if (parts.length !== 2) return res.status(401).json({ error: "Invalid token" });
  const token = parts[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ----------------- AUTH ROUTES ----------------- */

// Signup: create user (unverified) and send OTP
app.post("/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: "Missing fields" });

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: "Email already registered" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashed, verified: false });

    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await OTP.create({ email, code, expiresAt });
    await sendOTPEmail(email, code).catch((err) => {
      console.error("OTP mail error:", err);
    });

    return res.json({ success: true, message: "OTP sent to email" });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Verify OTP and return JWT
app.post("/auth/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: "Missing fields" });

    const record = await OTP.findOne({ email, code: otp });
    if (!record) return res.status(400).json({ error: "Invalid OTP" });
    if (record.expiresAt < new Date()) {
      await OTP.deleteOne({ _id: record._id });
      return res.status(400).json({ error: "OTP expired" });
    }

    // mark user verified
    const user = await User.findOneAndUpdate({ email }, { verified: true }, { new: true });
    if (!user) return res.status(400).json({ error: "User not found" });

    await OTP.deleteMany({ email });

    const token = signToken(user);
    return res.json({ success: true, token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (error) {
    console.error("Verify OTP error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Signin: email + password -> JWT
app.post("/auth/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: "Invalid credentials" });

    if (!user.verified) {
      return res.status(400).json({ error: "Email not verified. Please complete signup OTP." });
    }

    const token = signToken(user);
    return res.json({ success: true, token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (error) {
    console.error("Signin error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ----------------- ANALYZE / UPLOAD / GITHUB ROUTES (modified to save to DB) ----------------- */

// Direct code analysis (no auth required but will store if auth provided)
app.post("/api/analyze/code", async (req, res) => {
  try {
    const { code, filename = "code.txt" } = req.body;
    if (!code) return res.status(400).json({ error: "No code provided" });

    const language = detectLanguage(filename);
    const aiResponse = await callGeminiAPI(code, language !== "unknown" ? language : "javascript");

    // If auth provided, save as analysis
    const auth = req.headers.authorization;
    if (auth) {
      try {
        const token = auth.split(" ")[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        await Analysis.create({
          userId: decoded.id,
          uploadId: `inline-${Date.now()}`,
          files: [{ path: filename, language, issues: aiResponse.issues || [] }],
        });
      } catch (e) {
        // ignore save failure
      }
    }

    res.json(aiResponse);
  } catch (error) {
    console.error("Code analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

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

// Analyze uploaded folder (save results to DB if auth)
app.post("/api/analyze/:uploadId", authMiddleware, async (req, res) => {
  try {
    const { uploadId } = req.params;
    const extractPath = path.join(EXTRACTED_PATH, uploadId);

    if (!fs.existsSync(extractPath)) {
      return res.status(400).json({ error: "Upload not found" });
    }

    const files = readCodeFiles(extractPath);
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });

    const aiResponse = await analyzeFiles(files);

    // Save analysis to DB
    const saved = await Analysis.create({
      userId: req.user.id,
      uploadId,
      files: aiResponse,
    });

    res.json({ analysis: aiResponse, savedId: saved._id });
  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({ error: "Analysis failed" });
  }
});

// Upload & analyze directly (and save)
app.post("/api/analyze/upload", authMiddleware, upload.array("files"), async (req, res) => {
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

    // Save to DB
    const saved = await Analysis.create({
      userId: req.user.id,
      uploadId: path.basename(extractPath),
      files: aiResponse,
    });

    res.json({ analysis: aiResponse, savedId: saved._id });
  } catch (error) {
    console.error("Upload analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GitHub repo analysis (and save)
app.post("/analyze/github", authMiddleware, async (req, res) => {
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

    const saved = await Analysis.create({
      userId: req.user.id,
      uploadId: `github-${Date.now()}`,
      files: aiResponse,
    });

    res.json({ analysis: aiResponse, savedId: saved._id });
  } catch (error) {
    console.error("GitHub analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ----------------- Chat endpoints ----------------- */

// Create or append to a chat: send message (and optional files) -> analyze & save
// Body: { chatId (optional), text (optional) }, files can be attached as form-data 'files'
app.post("/chat/send", authMiddleware, upload.array("files"), async (req, res) => {
  try {
    const { chatId, text } = req.body;
    const userId = req.user.id;

    // If files included, move them to extracted and analyze
    const attachedFiles = [];
    if (req.files && req.files.length > 0) {
      const extractPath = path.join(EXTRACTED_PATH, `chat-${Date.now()}`);
      fs.mkdirSync(extractPath, { recursive: true });
      for (const file of req.files) {
        const dest = path.join(extractPath, file.originalname);
        fs.renameSync(file.path, dest);
        attachedFiles.push({ path: dest });
      }

      // read code files and analyze
      const files = readCodeFiles(extractPath);
      let analysisResult = [];
      if (files.length > 0) {
        analysisResult = await analyzeFiles(files);
        // Save analysis
        await Analysis.create({
          userId,
          uploadId: path.basename(extractPath),
          files: analysisResult,
        });
      }
    }

    // find or create chat
    let chat;
    if (chatId) {
      chat = await Chat.findById(chatId);
    }
    if (!chat) {
      chat = await Chat.create({ userId, messages: [] });
    }

    // push user's message
    if (text) {
      chat.messages.push({ role: "user", text, files: attachedFiles.map((f) => f.path) });
    } else if (attachedFiles.length > 0) {
      chat.messages.push({ role: "user", text: "Uploaded files for analysis", files: attachedFiles.map((f) => f.path) });
    } else {
      return res.status(400).json({ error: "No text or files provided" });
    }

    // Simple assistant placeholder response (you can replace with AI reply later)
    const assistantText = "Analysis started. Results will be attached as separate analysis records.";
    chat.messages.push({ role: "assistant", text: assistantText, files: [] });

    await chat.save();

    return res.json({ success: true, chatId: chat._id, chat });
  } catch (error) {
    console.error("Chat send error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get chat history for user (list of chats)
app.get("/chat/history", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const chats = await Chat.find({ userId }).sort({ createdAt: -1 }).limit(100);
    return res.json({ chats });
  } catch (error) {
    console.error("Chat history error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get specific chat by ID (must belong to user)
app.get("/chat/:chatId", authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;
    const chat = await Chat.findOne({ _id: chatId, userId });
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    return res.json({ chat });
  } catch (error) {
    console.error("Get chat error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get user's analyses
app.get("/analyses", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const analyses = await Analysis.find({ userId }).sort({ createdAt: -1 }).limit(100);
    return res.json({ analyses });
  } catch (error) {
    console.error("Get analyses error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ----------------- Health ----------------- */
app.get("/health", (req, res) => res.json({ status: "OK", message: "Server running" }));

/* ----------------- Start server ----------------- */
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));