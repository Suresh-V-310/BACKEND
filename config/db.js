import mongoose from 'mongoose';

/**
 * Connect to MongoDB using Mongoose
 * Uses connection string from environment variables
 */
const connectDB = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      console.warn(
        'MongoDB is not configured (MONGODB_URI missing). Auth/snippets will be unavailable until you set server/.env.'
      );
      return;
    }
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;
