import mongoose from 'mongoose';
import { RUNTIME_CAPABILITIES } from '../languages/runtimeCapabilities.js';

/**
 * Snippet Schema - saved code snippets per user
 */
const snippetSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: [100, 'Title cannot exceed 100 characters'],
    },
    language: {
      type: String,
      required: true,
      enum: Object.keys(RUNTIME_CAPABILITIES),
    },
    code: {
      type: String,
      required: true,
      default: '',
    },
    files: {
      type: Map,
      of: String,
      default: undefined,
    },
    runtimeOptions: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    description: {
      type: String,
      default: '',
      maxlength: [500, 'Description cannot exceed 500 characters'],
    },
    isFavorite: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

snippetSchema.index({ user: 1, updatedAt: -1 });

const Snippet = mongoose.model('Snippet', snippetSchema);
export default Snippet;
