/**
 * API 文档 - OpenAPI 3.0 规范
 */

export const apiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'AutoSnippet API',
    description: '自动代码片段管理系统 REST API',
    version: '2.0.0',
    contact: {
      name: 'AutoSnippet Team',
      url: 'https://github.com/autosnippet',
    },
  },
  servers: [
    {
      url: 'http://localhost:3000/api/v1',
      description: 'Development server',
    },
    {
      url: 'https://api.autosnippet.dev/api/v1',
      description: 'Production server',
    },
  ],
  paths: {
    '/health': {
      get: {
        summary: '健康检查',
        description: '检查服务器是否正常运行',
        tags: ['System'],
        responses: {
          200: {
            description: '服务器状态正常',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    status: { type: 'string', example: 'healthy' },
                    timestamp: { type: 'number', example: 1675900000 },
                    uptime: { type: 'number', example: 3600 },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        summary: '就绪检查',
        description: '检查服务器是否已准备好处理请求',
        tags: ['System'],
        responses: {
          200: {
            description: '服务器已准备好',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    ready: { type: 'boolean', example: true },
                    timestamp: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/rules': {
      get: {
        summary: '获取防护规则列表',
        tags: ['GuardRules'],
        responses: {
          200: {
            description: '规则列表',
          },
        },
      },
      post: {
        summary: '创建防护规则',
        tags: ['GuardRules'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'pattern', 'action'],
                properties: {
                  name: { type: 'string' },
                  category: { type: 'string' },
                  pattern: { type: 'string' },
                  condition: { type: 'object' },
                  action: { type: 'string' },
                  priority: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: '规则创建成功',
          },
        },
      },
    },
    '/rules/{id}': {
      get: {
        summary: '获取规则详情',
        tags: ['GuardRules'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: '规则详情',
          },
        },
      },
    },
    '/rules/{id}/enable': {
      patch: {
        summary: '启用规则',
        tags: ['GuardRules'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: '启用成功',
          },
        },
      },
    },
    '/rules/{id}/disable': {
      patch: {
        summary: '禁用规则',
        tags: ['GuardRules'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: '禁用成功',
          },
        },
      },
    },
  },
  components: {
    schemas: {
      GuardRule: {
        type: 'object',
        description: 'Guard rules are now boundary-constraint type Recipes',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          knowledgeType: { type: 'string', enum: ['boundary-constraint'] },
          constraints: { type: 'object' },
          status: { type: 'string' },
          createdAt: { type: 'number' },
        },
      },
    },
  },
};

export default apiSpec;
