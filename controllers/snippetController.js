import Snippet from '../models/Snippet.js';

/**
 * Get all snippets for logged-in user
 */
export const getSnippets = async (req, res, next) => {
  try {
    const snippets = await Snippet.find({ user: req.user._id })
      .sort({ updatedAt: -1 })
      .select('-__v');

    res.json({
      success: true,
      count: snippets.length,
      snippets,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get single snippet by ID
 */
export const getSnippet = async (req, res, next) => {
  try {
    const snippet = await Snippet.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!snippet) {
      return res.status(404).json({
        success: false,
        message: 'Snippet not found',
      });
    }

    res.json({ success: true, snippet });
  } catch (error) {
    next(error);
  }
};

/**
 * Create a new code snippet
 */
export const createSnippet = async (req, res, next) => {
  try {
    const { title, language, code, files, runtimeOptions, description } = req.body;

    if (!title || !language || (code === undefined && files === undefined)) {
      return res.status(400).json({
        success: false,
        message: 'Title, language, and code or files are required',
      });
    }

    const snippet = await Snippet.create({
      user: req.user._id,
      title,
      language,
      code: code ?? '',
      files,
      runtimeOptions: runtimeOptions || {},
      description: description || '',
    });

    res.status(201).json({
      success: true,
      message: 'Snippet saved successfully',
      snippet,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update existing snippet
 */
export const updateSnippet = async (req, res, next) => {
  try {
    let snippet = await Snippet.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!snippet) {
      return res.status(404).json({
        success: false,
        message: 'Snippet not found',
      });
    }

    const { title, language, code, files, runtimeOptions, description, isFavorite } = req.body;

    if (title) snippet.title = title;
    if (language) snippet.language = language;
    if (code !== undefined) snippet.code = code;
    if (files !== undefined) snippet.files = files;
    if (runtimeOptions !== undefined) snippet.runtimeOptions = runtimeOptions;
    if (description !== undefined) snippet.description = description;
    if (isFavorite !== undefined) snippet.isFavorite = isFavorite;

    await snippet.save();

    res.json({
      success: true,
      message: 'Snippet updated successfully',
      snippet,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a snippet
 */
export const deleteSnippet = async (req, res, next) => {
  try {
    const snippet = await Snippet.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!snippet) {
      return res.status(404).json({
        success: false,
        message: 'Snippet not found',
      });
    }

    res.json({
      success: true,
      message: 'Snippet deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};
