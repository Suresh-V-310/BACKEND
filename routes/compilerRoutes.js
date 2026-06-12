import express from 'express';
import {
  runCode,
  getLanguages,
  getDefaultCode,
  getCapabilities,
  getRuntimes,
} from '../controllers/compilerController.js';

const router = express.Router();

router.post('/run', runCode);
router.get('/languages', getLanguages);
router.get('/capabilities', getCapabilities);
router.get('/runtimes', getRuntimes);
router.get('/default/:language', getDefaultCode);

export default router;
