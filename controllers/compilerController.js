import { getLanguageByKey, getLanguageList, getLanguageCapabilities } from '../config/languages.js';
import { localRunCode } from '../src/services/executionService.js';
import { getRuntimeStatus } from '../src/runtimeManager.js';

/**
 * Execute code using local compilers/interpreters
 */
export const runCode = async (req, res, next) => {
  try {
    const { language, code, files, stdin = '', mainClass, buildTool, cStandard } = req.body;
    if (!language || (code === undefined && files === undefined)) {
      return res.status(400).json({ success: false, message: 'Language and code or files are required' });
    }

    const result = await localRunCode({ language, code, files, stdin, mainClass, buildTool, cStandard });
    const isDev = process.env.NODE_ENV !== 'production' || process.env.ENABLE_RENDER_DEBUG === 'true';
    if (result && result.success === false) {
      return res.json({
        success: false,
        result,
        error: result.error || 'Execution failed',
        ...(isDev ? {
          debug: {
            pythonPath: result.debug?.pythonPath || '',
            command: result.debug?.command || '',
            cwd: result.debug?.cwd || process.cwd()
          }
        } : {})
      });
    }
    res.json({ success: true, result });
  } catch (error) {
    console.error('Execution error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to execute code',
    });
  }
};

/**
 * Get list of supported languages
 */
export const getLanguages = async (req, res) => {
  res.json({
    success: true,
    languages: getLanguageList(),
  });
};

/**
 * Get standard library/package/runtime capabilities for supported stacks.
 */
export const getCapabilities = async (req, res) => {
  res.json({
    success: true,
    capabilities: getLanguageCapabilities(),
  });
};

/**
 * Get local toolchain/container readiness.
 */
export const getRuntimes = async (req, res, next) => {
  try {
    res.json({
      success: true,
      runtimes: await getRuntimeStatus(),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get default starter code for a language
 */
export const getDefaultCode = async (req, res) => {
  const langConfig = getLanguageByKey(req.params.language);

  if (!langConfig) {
    return res.status(404).json({
      success: false,
      message: 'Language not found',
    });
  }

  res.json({
    success: true,
    language: req.params.language,
    code: langConfig.defaultCode,
    extension: langConfig.extension,
  });
};
