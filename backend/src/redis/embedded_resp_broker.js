import net from 'net';

export class EmbeddedRespBroker {
  constructor(port = 6379, host = '127.0.0.1') {
    this.port = port;
    this.host = host;
    this.strings = new Map();
    this.lists = new Map();
    this.zsets = new Map();
    this.hashes = new Map();
    this.sets = new Map();
    this.expirations = new Map();
    this.subscribers = new Map();
    this.clients = new Set();
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.clients.add(socket);
        let buffer = '';

        socket.on('data', (data) => {
          buffer += data.toString('utf8');
          while (buffer.length > 0) {
            const parsed = this.parseResp(buffer);
            if (!parsed) break;
            buffer = buffer.slice(parsed.consumed);
            this.handleCommand(socket, parsed.command);
          }
        });

        socket.on('close', () => {
          this.clients.delete(socket);
          for (const [channel, sockets] of this.subscribers.entries()) {
            sockets.delete(socket);
          }
        });

        socket.on('error', () => {
          this.clients.delete(socket);
        });
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        resolve(true);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      for (const socket of this.clients) {
        socket.destroy();
      }
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  parseResp(str) {
    if (!str.startsWith('*')) {
      const lineEnd = str.indexOf('\r\n');
      if (lineEnd === -1) return null;
      const parts = str.slice(0, lineEnd).trim().split(/\s+/);
      return { command: parts, consumed: lineEnd + 2 };
    }

    let cursor = 0;
    const firstLineEnd = str.indexOf('\r\n', cursor);
    if (firstLineEnd === -1) return null;
    const numArgs = parseInt(str.slice(1, firstLineEnd), 10);
    cursor = firstLineEnd + 2;

    const args = [];
    for (let i = 0; i < numArgs; i++) {
      if (cursor >= str.length) return null;
      if (str[cursor] !== '$') return null;
      const lenEnd = str.indexOf('\r\n', cursor);
      if (lenEnd === -1) return null;
      const len = parseInt(str.slice(cursor + 1, lenEnd), 10);
      cursor = lenEnd + 2;

      if (len === -1) {
        args.push(null);
        continue;
      }

      if (cursor + len + 2 > str.length) return null;
      const val = str.slice(cursor, cursor + len);
      args.push(val);
      cursor = cursor + len + 2;
    }

    return { command: args, consumed: cursor };
  }

  handleCommand(socket, args) {
    if (!args || args.length === 0) return;
    const cmd = args[0].toUpperCase();

    if (cmd === 'PING') {
      socket.write('+PONG\r\n');
    } else if (cmd === 'COMMAND' || cmd === 'INFO' || cmd === 'SELECT') {
      socket.write('+OK\r\n');
    } else if (cmd === 'SET') {
      const key = args[1];
      const val = args[2];
      let nx = false;
      let px = null;

      for (let i = 3; i < args.length; i++) {
        if (args[i].toUpperCase() === 'NX') nx = true;
        if (args[i].toUpperCase() === 'PX' && args[i + 1]) {
          px = parseInt(args[i + 1], 10);
          i++;
        }
      }

      if (nx && this.strings.has(key)) {
        socket.write('$-1\r\n');
        return;
      }

      this.strings.set(key, val);
      if (px) {
        this.expirations.set(key, Date.now() + px);
        setTimeout(() => {
          this.strings.delete(key);
          this.expirations.delete(key);
        }, px);
      }
      socket.write('+OK\r\n');
    } else if (cmd === 'EXPIRE') {
      const key = args[1];
      const seconds = parseInt(args[2], 10);
      const px = seconds * 1000;
      if (this.strings.has(key)) {
        this.expirations.set(key, Date.now() + px);
        setTimeout(() => {
          this.strings.delete(key);
          this.expirations.delete(key);
        }, px);
        socket.write(':1\r\n');
      } else {
        socket.write(':0\r\n');
      }
    } else if (cmd === 'PEXPIRE') {
      const key = args[1];
      const px = parseInt(args[2], 10);
      if (this.strings.has(key)) {
        this.expirations.set(key, Date.now() + px);
        setTimeout(() => {
          this.strings.delete(key);
          this.expirations.delete(key);
        }, px);
        socket.write(':1\r\n');
      } else {
        socket.write(':0\r\n');
      }
    } else if (cmd === 'GET') {
      const key = args[1];
      const val = this.strings.get(key);
      if (val === undefined || val === null) {
        socket.write('$-1\r\n');
      } else {
        socket.write(`$${Buffer.byteLength(val)}\r\n${val}\r\n`);
      }
    } else if (cmd === 'DEL') {
      let count = 0;
      for (let i = 1; i < args.length; i++) {
        const key = args[i];
        this.expirations.delete(key);
        if (this.strings.delete(key)) count++;
        if (this.lists.delete(key)) count++;
        if (this.zsets.delete(key)) count++;
        if (this.hashes.delete(key)) count++;
        if (this.sets.delete(key)) count++;
      }
      socket.write(`:${count}\r\n`);
    } else if (cmd === 'LPUSH') {
      const key = args[1];
      if (!this.lists.has(key)) this.lists.set(key, []);
      const list = this.lists.get(key);
      for (let i = 2; i < args.length; i++) {
        list.unshift(args[i]);
      }
      socket.write(`:${list.length}\r\n`);
    } else if (cmd === 'RPUSH') {
      const key = args[1];
      if (!this.lists.has(key)) this.lists.set(key, []);
      const list = this.lists.get(key);
      for (let i = 2; i < args.length; i++) {
        list.push(args[i]);
      }
      socket.write(`:${list.length}\r\n`);
    } else if (cmd === 'LPOP') {
      const key = args[1];
      const list = this.lists.get(key);
      if (!list || list.length === 0) {
        socket.write('$-1\r\n');
      } else {
        const val = list.shift();
        socket.write(`$${Buffer.byteLength(val)}\r\n${val}\r\n`);
      }
    } else if (cmd === 'RPOP') {
      const key = args[1];
      const list = this.lists.get(key);
      if (!list || list.length === 0) {
        socket.write('$-1\r\n');
      } else {
        const val = list.pop();
        socket.write(`$${Buffer.byteLength(val)}\r\n${val}\r\n`);
      }
    } else if (cmd === 'SADD') {
      const key = args[1];
      if (!this.sets.has(key)) this.sets.set(key, new Set());
      const set = this.sets.get(key);
      let count = 0;
      for (let i = 2; i < args.length; i++) {
        if (!set.has(args[i])) {
          set.add(args[i]);
          count++;
        }
      }
      socket.write(`:${count}\r\n`);
    } else if (cmd === 'SREM') {
      const key = args[1];
      const set = this.sets.get(key);
      let count = 0;
      if (set) {
        for (let i = 2; i < args.length; i++) {
          if (set.delete(args[i])) count++;
        }
      }
      socket.write(`:${count}\r\n`);
    } else if (cmd === 'SMEMBERS') {
      const key = args[1];
      const set = this.sets.get(key) || new Set();
      const members = Array.from(set);
      let out = `*${members.length}\r\n`;
      for (const m of members) {
        out += `$${Buffer.byteLength(m)}\r\n${m}\r\n`;
      }
      socket.write(out);
    } else if (cmd === 'LLEN') {
      const key = args[1];
      const list = this.lists.get(key);
      socket.write(`:${list ? list.length : 0}\r\n`);
    } else if (cmd === 'LRANGE') {
      const key = args[1];
      const start = parseInt(args[2], 10);
      const stop = parseInt(args[3], 10);
      const list = this.lists.get(key) || [];
      const normalizedStart = start < 0 ? Math.max(0, list.length + start) : start;
      const normalizedStop = stop < 0 ? Math.max(0, list.length + stop) : stop;
      const items = list.slice(normalizedStart, normalizedStop + 1);
      let out = `*${items.length}\r\n`;
      for (const item of items) {
        out += `$${Buffer.byteLength(item)}\r\n${item}\r\n`;
      }
      socket.write(out);
    } else if (cmd === 'ZADD') {
      const key = args[1];
      if (!this.zsets.has(key)) this.zsets.set(key, new Map());
      const zset = this.zsets.get(key);
      let added = 0;
      for (let i = 2; i < args.length; i += 2) {
        const score = parseFloat(args[i]);
        const member = args[i + 1];
        if (!zset.has(member)) added++;
        zset.set(member, score);
      }
      socket.write(`:${added}\r\n`);
    } else if (cmd === 'ZRANGEBYSCORE') {
      const key = args[1];
      const min = args[2] === '-inf' ? -Infinity : parseFloat(args[2]);
      const max = args[3] === '+inf' ? Infinity : parseFloat(args[3]);
      const zset = this.zsets.get(key) || new Map();
      const matching = [];
      for (const [member, score] of zset.entries()) {
        if (score >= min && score <= max) {
          matching.push({ member, score });
        }
      }
      matching.sort((a, b) => a.score - b.score);
      let out = `*${matching.length}\r\n`;
      for (const item of matching) {
        out += `$${Buffer.byteLength(item.member)}\r\n${item.member}\r\n`;
      }
      socket.write(out);
    } else if (cmd === 'ZREM') {
      const key = args[1];
      const zset = this.zsets.get(key);
      let removed = 0;
      if (zset) {
        for (let i = 2; i < args.length; i++) {
          if (zset.delete(args[i])) removed++;
        }
      }
      socket.write(`:${removed}\r\n`);
    } else if (cmd === 'HSET') {
      const key = args[1];
      if (!this.hashes.has(key)) this.hashes.set(key, new Map());
      const hash = this.hashes.get(key);
      let added = 0;
      for (let i = 2; i < args.length; i += 2) {
        const field = args[i];
        const val = args[i + 1];
        if (!hash.has(field)) added++;
        hash.set(field, val);
      }
      socket.write(`:${added}\r\n`);
    } else if (cmd === 'HGET') {
      const key = args[1];
      const field = args[2];
      const hash = this.hashes.get(key);
      const val = hash ? hash.get(field) : null;
      if (val === undefined || val === null) {
        socket.write('$-1\r\n');
      } else {
        socket.write(`$${Buffer.byteLength(val)}\r\n${val}\r\n`);
      }
    } else if (cmd === 'HGETALL') {
      const key = args[1];
      const hash = this.hashes.get(key) || new Map();
      const entries = Array.from(hash.entries());
      let out = `*${entries.length * 2}\r\n`;
      for (const [f, v] of entries) {
        out += `$${Buffer.byteLength(f)}\r\n${f}\r\n`;
        out += `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
      }
      socket.write(out);
    } else if (cmd === 'PUBLISH') {
      const channel = args[1];
      const message = args[2];
      const subs = this.subscribers.get(channel) || new Set();
      let count = 0;
      for (const subSocket of subs) {
        try {
          const out = `*3\r\n$7\r\nmessage\r\n$${Buffer.byteLength(channel)}\r\n${channel}\r\n$${Buffer.byteLength(message)}\r\n${message}\r\n`;
          subSocket.write(out);
          count++;
        } catch (e) {}
      }
      socket.write(`:${count}\r\n`);
    } else if (cmd === 'SUBSCRIBE') {
      for (let i = 1; i < args.length; i++) {
        const channel = args[i];
        if (!this.subscribers.has(channel)) this.subscribers.set(channel, new Set());
        this.subscribers.get(channel).add(socket);
        socket.write(`*3\r\n$9\r\nsubscribe\r\n$${Buffer.byteLength(channel)}\r\n${channel}\r\n:${i}\r\n`);
      }
    } else if (cmd === 'PTTL') {
      const key = args[1];
      const expireAt = this.expirations.get(key);
      if (!this.strings.has(key) && !this.lists.has(key) && !this.sets.has(key)) {
        socket.write(':-2\r\n');
      } else if (!expireAt) {
        socket.write(':-1\r\n');
      } else {
        const remaining = Math.max(0, expireAt - Date.now());
        socket.write(`:${remaining}\r\n`);
      }
    } else if (cmd === 'TTL') {
      const key = args[1];
      const expireAt = this.expirations.get(key);
      if (!this.strings.has(key) && !this.lists.has(key) && !this.sets.has(key)) {
        socket.write(':-2\r\n');
      } else if (!expireAt) {
        socket.write(':-1\r\n');
      } else {
        const remaining = Math.max(0, Math.ceil((expireAt - Date.now()) / 1000));
        socket.write(`:${remaining}\r\n`);
      }
    } else if (cmd === 'EVALSHA') {
      socket.write('-NOSCRIPT No matching script. Please use EVAL.\r\n');
    } else if (cmd === 'EVAL') {
      const script = args[1] || '';
      const numKeys = parseInt(args[2], 10);
      const keys = args.slice(3, 3 + numKeys);
      const scriptArgs = args.slice(3 + numKeys);

      // Distributed Lock Release Lua Script: if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end
      if (script.includes('get') && script.includes('del')) {
        const key = keys[0];
        const expectedVal = scriptArgs[0];
        const currentVal = this.strings.get(key);
        if (currentVal && currentVal === expectedVal) {
          this.strings.delete(key);
          this.expirations.delete(key);
          socket.write(':1\r\n');
        } else {
          socket.write(':0\r\n');
        }
        return;
      }

      // Queue pop script
      if (keys.length > 0) {
        const queueKey = keys[0];
        const activeKey = keys[1];
        const list = this.lists.get(queueKey);
        if (list && list.length > 0) {
          const popped = list.pop();
          if (activeKey) {
            if (!this.sets.has(activeKey)) this.sets.set(activeKey, new Set());
            this.sets.get(activeKey).add(popped);
          }
          socket.write(`$${Buffer.byteLength(popped)}\r\n${popped}\r\n`);
          return;
        }
      }
      socket.write('$-1\r\n');
    } else if (cmd === 'KEYS') {
      const allKeys = [
        ...this.strings.keys(),
        ...this.lists.keys(),
        ...this.zsets.keys(),
        ...this.hashes.keys(),
        ...this.sets.keys()
      ];
      const uniqueKeys = Array.from(new Set(allKeys));
      let out = `*${uniqueKeys.length}\r\n`;
      for (const k of uniqueKeys) {
        out += `$${Buffer.byteLength(k)}\r\n${k}\r\n`;
      }
      socket.write(out);
    } else {
      socket.write('+OK\r\n');
    }
  }
}
