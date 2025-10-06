import express from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import cors from "cors";
import simpleGit from "simple-git";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fetch from "node-fetch"; // ✅ add if Node < 18

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

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

// Gemini API key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyCk3VyHVj3_UMqtHlN5NhbS5pv9yMHDSTs";

// Middleware
app.use(express.json());
app.use(express.static("public"));

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads/";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

// Helper delay
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Language extensions
const LANGUAGE_EXTENSIONS = {
  python: [".py"],
  javascript: [".js", ".jsx"],
  typescript: [".ts", ".tsx"],
  java: [".java"],
  c: [".c"],
  cpp: [".cpp", ".cc", ".cxx", ".c++"],
  php: [".php"],
};

// Dependency/config files
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

// Detect language
function detectLanguage(filename) {
  const ext = path.extname(filename).toLowerCase();
  for (const [lang, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (extensions.includes(ext)) return lang;
  }
  return "unknown";
}

// File filters
function isCodeFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return Object.values(LANGUAGE_EXTENSIONS).flat().includes(ext);
}
function isDependencyFile(filename) {
  return DEPENDENCY_FILES.includes(path.basename(filename));
}

// Extract zip
function extractZip(zipPath, extractPath) {
  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);
    return true;
  } catch (error) {
    console.error("Error extracting zip:", error);
    return false;
  }
}

// Clone repo

// Read files
function readCodeFiles(dirPath) {
  const files = [];
  const ignoreDirs = [".git", "node_modules", "vendor", "dist", "build", "pycache"];
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

// ---- SSE Support ----
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

// Call Gemini
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
        console.warn("⚠️ Rate limited. Retrying...");
        await delay(2000 * (i + 1));
        continue;
      }
      if (!response.ok) throw new Error(`Gemini API error: ${response.statusText}`);
      const data = await response.json();
      let text = data.candidates[0].content.parts[0].text.trim();
      if (text.startsWith("```json")) text = text.replace(/```json|```/g, "");
      return JSON.parse(text);
    } catch (err) {
      if (i === retries - 1) {
        return {
          issues: [
            { line: 0, type: "error", message: err.message, suggestion: "Check API call" },
          ],
        };
      }
    }
  }
}

// Analyze files with SSE logs
async function analyzeFiles(files) {
  const results = [];
  const total = files.length;

  console.log(`📑 Starting analysis of ${total} files...`);
  broadcast("progress", { message: `📑 Starting analysis of ${total} files`, progress: 0 });

  for (let i = 0; i < total; i++) {
    const file = files[i];
    const progress = (((i + 1) / total) * 100).toFixed(1);

    const msg = `🔍 [${i + 1}/${total}] (${progress}%) Analyzing ${file.path}`;
    console.log(msg);
    broadcast("progress", { message: msg, progress });

    let issues = [];
    const aiResult = await callGeminiAPI(
      `--- File: ${file.path} ---\n${file.content}`,
      file.language
    );
    if (aiResult.issues) {
      const doneMsg = `✅  Vektor  analyzed ${file.path}, found ${aiResult.issues.length} issues`;
      console.log(doneMsg);
      broadcast("progress", { message: doneMsg, progress });
      issues = issues.concat(aiResult.issues);
    }

    results.push({ file: file.path, language: file.language, issues });

    console.log("⏳ Waiting before next file...");
    await delay(1000);
  }

  console.log("🚀 Analysis complete.");
  broadcast("end", { message: "🚀 Analysis complete." });
  return results;
}


// Direct code
app.post("/api/analyze/code", async (req, res) => {
  try {
    const { code, filename = "code.txt" } = req.body;
    if (!code) return res.status(400).json({ error: "No code provided" });

    const language = detectLanguage(filename);
    const aiResponse = await callGeminiAPI(
      code,
      language !== "unknown" ? language : "javascript"
    );
    res.json(aiResponse);
  } catch (error) {
    console.error(error);
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
    const extractPath = `extracted/${uploadId}`;
    fs.mkdirSync(extractPath, { recursive: true });

    for (const file of req.files) {
      const dest = path.join(extractPath, file.originalname);
      fs.renameSync(file.path, dest);
    }

    res.json({ success: true, uploadId }); // return ID to use later
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Analyze after upload
app.post("/api/analyze/:uploadId", async (req, res) => {
  try {
    const { uploadId } = req.params;
    const extractPath = `extracted/${uploadId}`;

    if (!fs.existsSync(extractPath)) {
      return res.status(400).json({ error: "Upload not found" });
    }

    const files = readCodeFiles(extractPath);
    if (files.length === 0) {
      return res.status(400).json({ error: "No relevant files found" });
    }

    const aiResponse = await analyzeFiles(files);
    res.json(aiResponse);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Analysis failed" });
  }
});




// Upload
app.post("/api/analyze/upload", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const extractPath = `extracted/${Date.now()}`;
    fs.mkdirSync(extractPath, { recursive: true });

    // Move all files into extractPath
    for (const file of req.files) {
      const dest = path.join(extractPath, file.originalname);
      fs.renameSync(file.path, dest);
    }

    const files = readCodeFiles(extractPath);
    if (files.length === 0)
      return res.status(400).json({ error: "No relevant files found" });

    const aiResponse = await analyzeFiles(files);
    res.json(aiResponse);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});
// ---- Modify cloneRepository ----
async function cloneRepository(repoUrl, clonePath, token = null) {
  try {
    const git = simpleGit();
    let url = repoUrl;

    if (token) {
      // Insert token into HTTPS clone URL
      // https://<token>@github.com/username/repo.git
      url = repoUrl.replace(
        /^https:\/\//,
        `https://${token}@`
      );
    }

    await git.clone(url, clonePath);
    return true;
  } catch (error) {
    console.error("Error cloning repository:", error);
    return false;
  }
}

// GitHub
app.post("/analyze/github", async (req, res) => {
  try {
    const { repoUrl, token } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "Repository URL is required" });

    const clonePath = `repos/${Date.now()}`;
    fs.mkdirSync(clonePath, { recursive: true });

    if (!(await cloneRepository(repoUrl, clonePath, token))) {
      return res.status(500).json({ error: "Failed to clone repo" });
    }

    const files = readCodeFiles(clonePath);
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });

    const aiResponse = await analyzeFiles(files);
    res.json(aiResponse);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});



// Health check
app.get("/health", (req, res) => res.json({ status: "OK", message: "Server running" }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));