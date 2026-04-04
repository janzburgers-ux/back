const mongoose = require('mongoose');

const PushSubscriptionSchema = new mongoose.Schema({
  endpoint:   { type: String, required: true, unique: true },
  subscription: { type: mongoose.Schema.Types.Mixed, required: true },
  userAgent:  { type: String, default: '' },
  active:     { type: Boolean, default: true },
}, { timestamps: true });

const PushNotificationSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  body:        { type: String, required: true },
  icon:        { type: String, default: '🍔' },
  scheduledAt: { type: Date, default: null },
  sent:        { type: Boolean, default: false },
  sentAt:      { type: Date, default: null },
  delivered:   { type: Number, default: 0 },
}, { timestamps: true });

const PushSubscription = mongoose.model('PushSubscription', PushSubscriptionSchema);
const PushNotification = mongoose.model('PushNotification', PushNotificationSchema);

module.exports = PushSubscription;
module.exports.PushNotification = PushNotification;
