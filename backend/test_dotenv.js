import dotenv from 'dotenv';
import path from 'path';

const res = dotenv.config({ path: './.env.local' });
console.log('Dotenv parsed result:', res.parsed);
console.log('Dotenv error:', res.error);
console.log('process.env.GEMINI_API_KEY:', process.env.GEMINI_API_KEY);
