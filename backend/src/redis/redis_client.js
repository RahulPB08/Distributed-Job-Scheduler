import Redis from 'ioredis';
import { ENV } from '../config/env.js';
import { EmbeddedRespBroker } from './embedded_resp_broker.js';

let redisInstance = null;
let embeddedBroker = null;

export const startRedisBrokerIfNeeded = async () => {
  if (ENV.USE_EMBEDDED_BROKER && !embeddedBroker) {
    try {
      embeddedBroker = new EmbeddedRespBroker(ENV.REDIS_PORT, ENV.REDIS_HOST);
      const started = await embeddedBroker.start();
      if (started) {
        process.stdout.write(`Embedded Redis RESP broker started on port ${ENV.REDIS_PORT}\n`);
      }
    } catch (e) {}
  }
};

export const getRedisClient = () => {
  if (!redisInstance) {
    const options = {
      host: ENV.REDIS_HOST,
      port: ENV.REDIS_PORT,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return 100;
      },
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 500,
      lazyConnect: false
    };
    if (ENV.REDIS_PASSWORD) {
      options.password = ENV.REDIS_PASSWORD;
    }
    redisInstance = new Redis(options);
    redisInstance.on('error', () => {});
  }
  return redisInstance;
};

export const createDuplicateRedisClient = () => {
  const options = {
    host: ENV.REDIS_HOST,
    port: ENV.REDIS_PORT,
    retryStrategy: (times) => {
      if (times > 3) return null;
      return 100;
    },
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 500
  };
  if (ENV.REDIS_PASSWORD) {
    options.password = ENV.REDIS_PASSWORD;
  }
  const client = new Redis(options);
  client.on('error', () => {});
  return client;
};

export const closeRedisConnections = async () => {
  if (redisInstance) {
    try {
      redisInstance.disconnect();
    } catch (e) {}
    redisInstance = null;
  }
  if (embeddedBroker) {
    try {
      await embeddedBroker.stop();
    } catch (e) {}
    embeddedBroker = null;
  }
};
