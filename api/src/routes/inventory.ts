import { FastifyPluginAsync } from 'fastify';
import { PLANTS, DECORATIONS, CONSUMABLES } from '../utils/catalog.js';
import { withSpan, setAttrs, userIdAttr } from '../telemetry.js';

export const inventoryRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /inventory/:user_id
  fastify.get<{ Params: { user_id: string } }>('/inventory/:user_id', async (req, reply) => {
    const player = await withSpan(
      'inventory get',
      { attributes: { 'jds.user.id': userIdAttr(req.params.user_id) } },
      async () => {
        const p = await fastify.prisma.player.findUnique({
          where: { id: req.params.user_id },
          include: {
            inventory: true,
            decorations: true,
          },
        });
        setAttrs({ 'jds.inventory.found': !!p, 'jds.inventory.items': p?.inventory.length ?? 0 });
        return p;
      },
    );

    if (!player) {
      return reply.send({
        userId: req.params.user_id,
        coins: 0,
        items: [],
      });
    }

    const items = player.inventory.map((inv) => {
      const isCrop = inv.itemId.startsWith('crop_');
      const baseId = isCrop ? inv.itemId.replace('crop_', '') : inv.itemId;
      const plant = PLANTS[baseId];
      const consumable = CONSUMABLES[baseId];
      const decor = DECORATIONS[baseId];
      return {
        itemId: inv.itemId,
        baseId,
        catalogIndex: plant ? plant.index : consumable ? consumable.index : decor ? decor.index : undefined,
        name: plant ? (isCrop ? `${plant.name} (Colhida)` : plant.name) : consumable ? consumable.name : decor ? decor.name : inv.itemId,
        type: isCrop ? 'crop' : plant ? 'seed' : consumable ? 'consumable' : decor ? 'decoration' : 'item',
        quantity: inv.quantity,
        description: consumable ? consumable.description : undefined,
      };
    });

    return reply.send({
      userId: player.id,
      coins: player.coins,
      items,
      equippedDecorations: player.decorations,
    });
  });
};
