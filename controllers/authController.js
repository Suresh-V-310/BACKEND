import jwt from 'jsonwebtoken';
import User from '../models/User.js';

/**
 * Generate JWT token for authenticated user
 */
export const generateToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

/**
 * Register a new user
 */
export const register = async (req, res, next) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide username, email, and password',
      });
    }

    const existingUser = await User.findOne({
      $or: [{ email }, { username }],
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email or username already exists',
      });
    }

    const user = await User.create({ username, email, password });
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token,
      user,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Login existing user
 */
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password',
      });
    }

    const user = await User.findOne({ email }).select('+password');

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    const token = generateToken(user._id);
    user.password = undefined;

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get current logged-in user profile
 */
export const getMe = async (req, res, next) => {
  try {
    res.json({
      success: true,
      user: req.user,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update user profile and preferences
 */
export const updateProfile = async (req, res, next) => {
  try {
    const { username, avatar, preferences } = req.body;
    const user = req.user;

    if (username) user.username = username;
    if (avatar !== undefined) user.avatar = avatar;

    if (preferences) {
      user.preferences = { ...user.preferences.toObject(), ...preferences };
    }

    await user.save();

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Add file to recent files list
 */
export const addRecentFile = async (req, res, next) => {
  try {
    const { title, language } = req.body;
    const user = req.user;

    user.recentFiles = user.recentFiles.filter((f) => f.title !== title);
    user.recentFiles.unshift({ title, language, updatedAt: new Date() });
    user.recentFiles = user.recentFiles.slice(0, 10);

    await user.save();

    res.json({
      success: true,
      recentFiles: user.recentFiles,
    });
  } catch (error) {
    next(error);
  }
};
