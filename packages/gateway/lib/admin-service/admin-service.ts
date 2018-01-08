import { AdapterPlugin, ConnectorPlugin, Plugin, Intermediary,
    Adapter, Connector, InitResult, IntermediaryPlugin, Callable,
    AdapterInitResult, IntermediaryInitResult, ConnectorInitResult  } from '@any2api/gateway-common';
    
import { Config, PluginDefinition } from './config';

interface ConfigInstance {
    adapter: AdapterInitResult;
    intermediaries: IntermediaryInitResult[];
    connector: ConnectorInitResult;
} 

/**
 * Service for management of configurations.
 */
export class AdminService {

    private idCounter = 0;
    private configDict: { [id: string]: { config: Config, instance: ConfigInstance } } = {};

    /**
     * 
     * @param config 
     * @returns promise of id of the created config.
     * A successful promise means all plugins of the config were succesfully started.
     */
    public createConfig(config: Config): Promise<string> {
        const id = String(++this.idCounter);

        return this.executeConfig(config)
            .then((instance) => {
                this.configDict[id] =  { config, instance };
                return id;
            });
    }

    public deleteConfig(id: string) {
        const config = this.configDict[id];
        return config.instance.adapter.instance.gracefullShutdown();
    }

    public getConfig(id: string): Config {
        return this.configDict[id].config;
    }

    private executeConfig = async (config: Config): Promise<ConfigInstance> => {

        const connector = this.loadConnector(config);
        
        const connectorConfig = config.protoService ?
            { 
                address: `${config.protoService.host}:${config.protoService.port}`,
                insecure: true,
                protoDefinition: config.protoService.protoDefinition,
                protoUrl: config.protoService.protoUrl
            }
            : config.connector.pluginConfig;

        const connectorInitResult = await connector.init(connectorConfig);

        const intermediaryInitResults: IntermediaryInitResult[] = [];

        const upstream =
            await config.intermediaries.reduceRight(
                async (upPromise: Promise<{ instance: Callable, serviceDefinition }>, intermediaryDefinition)  => {
                    const intermediary = this.loadPlugin(intermediaryDefinition) as IntermediaryPlugin;

                    const up = await upPromise;
                    
                    const initResult = await intermediary.init(
                        up.serviceDefinition,
                        up.instance,
                        intermediaryDefinition.pluginConfig);
                    
                    intermediaryInitResults.unshift(initResult);

                    return {
                        instance: initResult.instance,
                        serviceDefinition: initResult.updatedServiceDefinition || up.serviceDefinition
                    };
                },
                Promise.resolve(connectorInitResult));

        const adapter = this.loadPlugin(config.adapter) as AdapterPlugin;

        const adapterInitResult = await adapter.init(
            upstream.serviceDefinition,
            upstream.instance,
            config.adapter.pluginConfig);

        return { 
            adapter: adapterInitResult,
            intermediaries: intermediaryInitResults,
            connector: connectorInitResult
        };
    }

    private loadConnector(config: Config): ConnectorPlugin {
        if (config.protoService) {
            return this.loadPluginPackage('@any2api/grpc-connector') as ConnectorPlugin;
        } else {
            if (config.connector.plugin) {
                return config.connector.plugin as ConnectorPlugin;
            } else {
                return this.loadPluginPackage(config.connector.pluginName) as ConnectorPlugin;
            }
        }
    }

    private loadPlugin(pluginDefinition: PluginDefinition): Plugin {
        if (pluginDefinition.plugin) {
            return pluginDefinition.plugin;
        } else {
            return this.loadPluginPackage(pluginDefinition.pluginName);
        }
    }

    private loadPluginPackage(name: string): Plugin {
        const plugin = require(name);

        if (!plugin) {
            throw new Error('Could not require plugin package');
        }

        return plugin;
    }

    private isPluginDefinition(plugin: { packageName?: string }) {
        return typeof plugin.packageName === 'string';
    }
}
