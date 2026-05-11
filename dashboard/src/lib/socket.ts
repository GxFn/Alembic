/**
 * Socket.io 单例连接
 *
 * 全局只创建一个 Socket.io 连接，所有 hook 共享同一连接。
 * 避免每次组件 mount/unmount 时反复创建/销毁连接。
 */

import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(window.location.origin, {
      path: '/socket.io',
      transports: ['websocket'],  // 跳过 polling，避免 Vite 代理下轮询降级导致反复重连
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    });

    // Auto-join notifications room on connect/reconnect
    // 后端 RealtimeService 监听的事件名是 'join-notifications'
    socket.on('connect', () => {
      socket!.emit('join-notifications');
    });
  }
  return socket;
}

/**
 * 释放 socket 连接（仅用于测试或应用销毁时）
 */
export function destroySocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
