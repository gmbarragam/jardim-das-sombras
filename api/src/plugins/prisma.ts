import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import { FastifyPluginAsync } from 'fastify';
import { isEnabled, withSpan, SpanKind } from '../telemetry.js';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

const prismaPlugin: FastifyPluginAsync = async (fastify) => {
  const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

  await prisma.$connect();

  fastify.decorate('prisma', isEnabled() ? withPrismaTracing(prisma) : prisma);

  fastify.addHook('onClose', async (instance) => {
    await instance.prisma.$disconnect();
    // Esvazia a fila de spans (teto de 3 s) quando a telemetria está ligada.
    const otelShutdown = (globalThis as Record<string, unknown>).__OTEL_SHUTDOWN as (() => Promise<unknown>) | undefined;
    if (otelShutdown) await otelShutdown();
  });
};

/**
 * Spans manuais por operação do Prisma (CLIENT): `prisma {Model}.{operation}`.
 * O @prisma/instrumentation 5.22 depende do sdk-trace-base 1.x e quebra com o SDK 2.x
 * (TypeError no callback do engine), por isso não é usado. Nunca grava args/valores.
 */
function withPrismaTracing(prisma: PrismaClient): PrismaClient {
  const extended = prisma.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        const name = model ? `prisma ${model}.${operation}` : `prisma ${operation}`;
        return withSpan(
          name,
          {
            kind: SpanKind.CLIENT,
            outcome: false,
            attributes: {
              'db.system.name': 'postgresql',
              'db.operation.name': operation,
              'db.collection.name': model,
            },
          },
          () => query(args),
        );
      },
    },
  });
  return extended as unknown as PrismaClient;
}

export default fp(prismaPlugin);
