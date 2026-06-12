import express from 'express';
import {
  getSnippets,
  getSnippet,
  createSnippet,
  updateSnippet,
  deleteSnippet,
} from '../controllers/snippetController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getSnippets).post(createSnippet);
router.route('/:id').get(getSnippet).put(updateSnippet).delete(deleteSnippet);

export default router;
