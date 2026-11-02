import type { Provider } from '@nestjs/common';
import { AdminGateway } from './admin.gateway';

/**
 * Add this provider to a module's providers array to advertise that the module
 * successfully resolved its Realtime integration during Nest bootstrap.
 * Operational health is reported separately by SystemMonitorService/workers.
 */
export function adminRealtimeRegistrationProvider(
  moduleName: string,
  description: string,
): Provider {
  const token = `ADMIN_REALTIME_READY_${moduleName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return {
    provide: token,
    inject: [AdminGateway],
    useFactory: (gateway: AdminGateway) => {
      gateway.registerModule(moduleName, {
        message: description,
        operationalStatus: 'UNKNOWN',
        details: { integration: 'connected' },
      });
      return Object.freeze({ module: moduleName, integrationReady: true });
    },
  };
}
