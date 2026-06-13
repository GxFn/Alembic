import type { Request, Response } from 'express';

type FlagSource = Request['body'] | Request['query'];

function booleanFlag(source: FlagSource, name: string): boolean {
  const value = source?.[name];
  if (Array.isArray(value)) {
    return value.some((item) => item === true || item === 'true' || item === '1');
  }
  return value === true || value === 'true' || value === '1';
}

export function operationConfirmed(req: Request, flagName = 'confirmed'): boolean {
  return booleanFlag(req.body, flagName) || booleanFlag(req.query, flagName);
}

export function rejectUnlessConfirmed(
  req: Request,
  res: Response,
  operation: string,
  flagName = 'confirmed'
): boolean {
  if (operationConfirmed(req, flagName)) {
    return true;
  }
  res.status(400).json({
    success: false,
    error: {
      code: 'OPERATION_CONFIRMATION_REQUIRED',
      message: `${operation} requires ${flagName}: true`,
    },
  });
  return false;
}

export function rejectInProduction(res: Response, operation: string): boolean {
  if (process.env.NODE_ENV !== 'production') {
    return false;
  }
  res.status(403).json({
    success: false,
    error: {
      code: 'OPERATION_DISABLED_IN_PRODUCTION',
      message: `${operation} is disabled in production`,
    },
  });
  return true;
}

export function operationContext(req: Request) {
  return {
    userId: req.resolvedSourceActor || req.resolvedSource || 'http-request',
    ip: req.ip || '',
    userAgent: req.headers['user-agent'] || '',
  };
}
