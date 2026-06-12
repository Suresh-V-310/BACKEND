import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import connectDB from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import snippetRoutes from './routes/snippetRoutes.js';
import compilerRoutes from './routes/compilerRoutes.js';
import { errorHandler, notFound } from './middleware/auth.js';
import { initializeRuntimes } from './src/runtimeManager.js';
import { getPythonExecutable } from './src/services/executionService.js';
import { exec } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), '.env') });

// Add local MinGW to PATH if on Windows
if (process.platform === 'win32') {
  const mingwPath = path.resolve(process.cwd(), '..', 'mingw64', 'bin');
  if (existsSync(mingwPath)) {
    process.env.PATH = `${mingwPath}${path.delimiter}${process.env.PATH}`;
  }
}

// Add local JDK to PATH and set JAVA_HOME if present (useful on Render native env)
const jdkPath = path.resolve(__dirname, 'jdk', 'bin');
if (existsSync(jdkPath)) {
  process.env.PATH = `${jdkPath}${path.delimiter}${process.env.PATH}`;
  process.env.JAVA_HOME = path.resolve(__dirname, 'jdk');
  console.log(`[JDK PATH LOADED]: ${jdkPath}`);
}

// Connect to MongoDB
connectDB();

const app = express();

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://frontend-green-alpha-50.vercel.app'
];

if (process.env.CLIENT_URL) {
  allowedOrigins.push(process.env.CLIENT_URL);
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes(origin) ||
        /^http:\/\/localhost(:\d+)?$/.test(origin) ||
        origin.endsWith('.vercel.app')
      ) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    optionsSuccessStatus: 200,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Health check route
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'OnlineCompiler API is running',
    timestamp: new Date().toISOString(),
  });
});

// Root path handler (important for Render health checks)
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'OnlineCompiler Backend Server is running',
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/snippets', snippetRoutes);
app.use('/api/compiler', compilerRoutes);

// Error handling
app.use(notFound);
app.use(errorHandler);

const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT) : 5000;
const MAX_PORT_ATTEMPTS = 10;

function startServer(port, attempts = 0) {
  const server = app.listen(port, () => {
    console.log(`OnlineCompiler Server running on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    initializeRuntimes().catch((err) => {
      console.warn('Runtime image initialization skipped:', err.message);
    });

    // Verify Python virtual environment at startup
    try {
      const pythonPath = getPythonExecutable();
      console.log("PYTHON:", pythonPath);
      exec(`"${pythonPath}" -c "import sys; print(sys.executable)"`, (err, stdout, stderr) => {
        if (err) {
          console.error('[PYTHON EXEC] Validation error:', err.message);
        } else {
          console.log(stdout.trim());
        }
      });
    } catch (err) {
      console.warn('[PYTHON EXEC] Verification failed:', err.message);
    }

    // Run dependency installation silently in the background
    const isWin = process.platform === 'win32';
    const scriptName = isWin ? 'install-runtime-dependencies.ps1' : 'install-runtime-dependencies.sh';
    const scriptPath = path.join(__dirname, 'scripts', scriptName);

    if (existsSync(scriptPath)) {
      const installerCommand = isWin
        ? `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`
        : `bash "${scriptPath}"`;
      
      console.log(`Starting background dependency installation: ${installerCommand}`);
      exec(installerCommand, { cwd: __dirname }, (err, stdout, stderr) => {
        if (err) {
          console.warn('Background dependency setup completed with some warnings/errors:', err.message);
        } else {
          console.log('Background dependency setup completed successfully.');
        }
      });
    } else {
      console.warn(`Background dependency setup script not found at: ${scriptPath}`);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts < MAX_PORT_ATTEMPTS) {
      const nextPort = port + 1;
      console.warn(`Port ${port} in use, trying ${nextPort}...`);
      startServer(nextPort, attempts + 1);
    } else {
      console.error('Failed to start server:', err);
    }
  });
}

startServer(DEFAULT_PORT);

export default app;
