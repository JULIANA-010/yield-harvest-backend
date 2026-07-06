require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const beneficiaryRoutes = require('./routes/beneficiaries');
const groupRoutes = require('./routes/groups');
const trainingRoutes = require('./routes/trainings');
const uploadRoutes = require('./routes/upload');

const app = express();

app.use(helmet());
app.use(cors()); // tighten to specific origins (dashboard domain) before production launch
app.use(express.json({ limit: '5mb' })); // allow for base64 photo payloads if not using multer directly

// basic rate limiting to protect against abuse, given the app will be
// reachable by 100 field agents on shared/patchy connections
app.use(
  '/api',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
  })
);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/beneficiaries', beneficiaryRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/trainings', trainingRoutes);
app.use('/api/upload', uploadRoutes);

// central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Yield Harvest API running on port ${PORT}`));
