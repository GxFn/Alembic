/**
 * WebSocket/Socket.io 实时通知服务
 * 提供候选人、食谱、规则的实时更新通知
 */

import { Server as SocketIOServer } from 'socket.io';
import Logger from '../logging/Logger.js';

export class RealtimeService {
  io: any;
  /**
   * @param {import('http').Server} httpServer
   */
  constructor(httpServer: any) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
      transports: ['websocket', 'polling'],
      pingInterval: 25000, // 25s 心跳间隔（默认值，显式声明）
      pingTimeout: 20000, // 20s 超时（默认值）
    });

    this.setupEventHandlers();
  }

  /**
   * 设置事件处理器
   */
  setupEventHandlers() {
    this.io.on('connection', (socket: any) => {
      Logger.debug(`[Socket.io] Client connected: ${socket.id}`);

      // 加入通知房间
      socket.on('join-notifications', () => {
        socket.join('notifications');
        socket.emit('notification-joined', {
          message: '已连接到实时通知',
          timestamp: Date.now(),
        });
      });

      // 离开通知房间
      socket.on('leave-notifications', () => {
        socket.leave('notifications');
      });

      // 处理断开连接
      socket.on('disconnect', () => {
        Logger.debug(`[Socket.io] Client disconnected: ${socket.id}`);
      });

      // 健康检查
      socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
      });
    });
  }

  /**
   * 广播候选人创建事件
   */
  broadcastCandidateCreated(candidate: any) {
    this.io.to('notifications').emit('candidate-created', {
      type: 'candidate_created',
      candidate,
      timestamp: Date.now(),
    });
  }

  /**
   * 广播候选人状态变化事件
   */
  broadcastCandidateStatusChanged(candidateId: any, newStatus: any, oldStatus: any) {
    this.io.to('notifications').emit('candidate-status-changed', {
      type: 'candidate_status_changed',
      candidateId,
      newStatus,
      oldStatus,
      timestamp: Date.now(),
    });
  }

  /**
   * 广播 Token 用量变化事件（Sidebar 指标刷新用）
   */
  broadcastTokenUsageUpdated() {
    this.io.to('notifications').emit('token-usage-updated', {
      type: 'token_usage_updated',
      timestamp: Date.now(),
    });
  }

  /**
   * 广播食谱创建事件
   */
  broadcastRecipeCreated(recipe: any) {
    this.io.to('notifications').emit('recipe-created', {
      type: 'recipe_created',
      recipe,
      timestamp: Date.now(),
    });
  }

  /**
   * 广播食谱发布事件
   */
  broadcastRecipePublished(recipeId: any, recipe: any) {
    this.io.to('notifications').emit('recipe-published', {
      type: 'recipe_published',
      recipeId,
      recipe,
      timestamp: Date.now(),
    });
  }

  /**
   * 广播规则创建事件
   */
  broadcastRuleCreated(rule: any) {
    this.io.to('notifications').emit('rule-created', {
      type: 'rule_created',
      rule,
      timestamp: Date.now(),
    });
  }

  /**
   * 广播规则状态变化事件
   */
  broadcastRuleStatusChanged(ruleId: any, enabled: any) {
    this.io.to('notifications').emit('rule-status-changed', {
      type: 'rule_status_changed',
      ruleId,
      enabled,
      timestamp: Date.now(),
    });
  }

  /**
   * 广播通用事件
   */
  broadcastEvent(eventName: any, data: any) {
    // 直接透传 data（不包装 type/timestamp），保持与前端 hook 期望的数据结构一致
    this.io.to('notifications').emit(eventName, data);
  }

  /**
   * 获取 Socket.io 实例
   */
  getIO() {
    return this.io;
  }

  /**
   * 获取连接的客户端数量
   */
  getConnectedClients() {
    return this.io.engine.clientsCount;
  }
}

// 单例实例
let realtimeService: RealtimeService | null = null;

export function initRealtimeService(httpServer: any) {
  if (!realtimeService) {
    realtimeService = new RealtimeService(httpServer);
    Logger.info('✅ RealtimeService initialized');
  }
  return realtimeService;
}

export function getRealtimeService() {
  if (!realtimeService) {
    throw new Error('RealtimeService not initialized. Call initRealtimeService() first.');
  }
  return realtimeService;
}
