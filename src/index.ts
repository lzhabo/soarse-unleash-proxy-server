import { TinyEmitter } from 'tiny-emitter';
import Metrics from './metrics';
import type IStorageProvider from './storage-provider';
import LocalStorageProvider from './storage-provider-local';
import InMemoryStorageProvider from './storage-provider-inmemory';

const DEFINED_FIELDS = ['userId', 'sessionId', 'remoteAddress'];

interface IStaticContext {
    appName: string;
    environment?: string;
}

interface IMutableContext {
    userId?: string;
    sessionId?: string;
    remoteAddress?: string;
    properties?: {
        [key: string]: string;
    };
}

type IContext = IStaticContext & IMutableContext;

interface IConfig extends IStaticContext {
    url: string;
    clientKey: string;
    disableRefresh?: boolean;
    refreshInterval?: number;
    metricsInterval?: number;
    disableMetrics?: boolean;
    storageProvider?: IStorageProvider;
    context?: IMutableContext;
    fetch?: any;
    bootstrap?: IToggle[];
    bootstrapOverride?: boolean;
}

interface IVariant {
    name: string;
    payload?: {
        type: string;
        value: string;
    };
}

interface IToggle {
    name: string;
    enabled: boolean;
    variant: IVariant;
}

export const EVENTS = {
    INIT: 'initialized',
    ERROR: 'error',
    READY: 'ready',
    UPDATE: 'update'
};

const defaultVariant: IVariant = { name: 'disabled' };
const storeKey = 'repo';

const resolveFetch = () => {
    try {
        if ('fetch' in window) {
            return fetch.bind(window);
        } else if ('fetch' in globalThis) {
            return fetch.bind(globalThis);
        }
    } catch (e) {
        console.error('Unleash failed to resolve "fetch"', e);
    }

    return undefined;
};

export class UnleashClient extends TinyEmitter {
    private toggles: IToggle[] = [];
    private context: IContext;
    private timerRef?: any;
    private storage: IStorageProvider;
    private refreshInterval: number;
    private url: URL;
    private clientKey: string;
    private etag: string = '';
    private metrics: Metrics;
    private ready: Promise<void>;
    private fetch: any;
    private bootstrap?: IToggle[];
    private bootstrapOverride: boolean;

    constructor({
                    storageProvider,
                    url,
                    clientKey,
                    disableRefresh = false,
                    refreshInterval = 30,
                    metricsInterval = 30,
                    disableMetrics = false,
                    appName,
                    environment = 'default',
                    context,
                    fetch = resolveFetch(),
                    bootstrap,
                    bootstrapOverride = true
                }: IConfig) {
        super();
        // Validations
        if (!url) {
            throw new Error('url is required');
        }
        if (!clientKey) {
            throw new Error('clientKey is required');
        }
        if (!appName) {
            throw new Error('appName is required.');
        }

        this.toggles = bootstrap && bootstrap.length > 0 ? bootstrap : [];
        this.url = new URL(`${url}`);
        this.clientKey = clientKey;
        this.storage = storageProvider || new LocalStorageProvider();
        this.refreshInterval = disableRefresh ? 0 : refreshInterval * 1000;
        this.context = { appName, environment, ...context };
        this.ready = new Promise(async (resolve) => {
            try {
                await this.init();
            } catch (error) {
                console.error(error);
                this.emit(EVENTS.ERROR, error);
            }
            resolve();
        });

        if (!fetch) {
            // tslint:disable-next-line
            console.error(
                'Unleash: You must either provide your own "fetch" implementation or run in an environment where "fetch" is available.'
            );
        }

        this.fetch = fetch;
        this.bootstrap =
            bootstrap && bootstrap.length > 0 ? bootstrap : undefined;
        this.bootstrapOverride = bootstrapOverride;

        this.metrics = new Metrics({
            appName,
            metricsInterval,
            disableMetrics,
            url,
            clientKey,
            fetch
        });
    }

    public getAllToggles(): IToggle[] {
        return [...this.toggles];
    }

    public isEnabled(toggleName: string): boolean {
        const toggle = this.toggles.find((t) => t.name === toggleName);
        const enabled = toggle ? toggle.enabled : false;
        this.metrics.count(toggleName, enabled);
        return enabled;
    }

    public getVariant(toggleName: string): IVariant {
        const toggle = this.toggles.find((t) => t.name === toggleName);
        if (toggle) {
            this.metrics.count(toggleName, true);
            return toggle.variant;
        } else {
            this.metrics.count(toggleName, false);
            return defaultVariant;
        }
    }

    public async updateContext(context: IMutableContext): Promise<void> {
        // Give the user a nicer error message when including
        // static fields in the mutable context object
        // @ts-ignore
        if (context.appName || context.environment) {
            console.warn(
                'appName and environment are static. They can\'t be updated with updateContext.'
            );
        }
        const staticContext = {
            environment: this.context.environment,
            appName: this.context.appName
        };
        this.context = { ...staticContext, ...context };
        if (this.timerRef) {
            await this.fetchToggles();
        }
    }

    public getContext() {
        return { ...this.context };
    }

    public setContextField(field: string, value: string) {
        if (DEFINED_FIELDS.includes(field)) {
            this.context = { ...this.context, [field]: value };
        } else {
            const properties = { ...this.context.properties, [field]: value };
            this.context = { ...this.context, properties };
        }
        if (this.timerRef) {
            this.fetchToggles();
        }
    }

    private async init(): Promise<void> {
        const sessionId = await this.resolveSessionId();
        this.context = { sessionId, ...this.context };

        this.toggles = (await this.storage.get(storeKey)) || [];

        if (
            this.bootstrap &&
            (this.bootstrapOverride || this.toggles.length === 0)
        ) {
            await this.storage.save(storeKey, this.bootstrap);
            this.toggles = this.bootstrap;
        }

        this.emit(EVENTS.INIT);
    }

    public async start(): Promise<void> {
        if (this.timerRef) {
            console.error(
                'Unleash SDK has already started, if you want to restart the SDK you should call client.stop() before starting again.'
            );
            return;
        }
        await this.ready;
        this.metrics.start();
        const interval = this.refreshInterval;
        await this.fetchToggles();
        this.emit(EVENTS.READY);
        if (interval > 0) {
            this.timerRef = setInterval(() => this.fetchToggles(), interval);
        }
    }

    public stop(): void {
        if (this.timerRef) {
            clearInterval(this.timerRef);
            this.timerRef = undefined;
        }
        this.metrics.stop();
    }

    private async resolveSessionId(): Promise<string> {
        if (this.context.sessionId) {
            return this.context.sessionId;
        } else {
            let sessionId = await this.storage.get('sessionId');
            if (!sessionId) {
                sessionId = Math.floor(Math.random() * 1_000_000_000);
                await this.storage.save('sessionId', sessionId);
            }
            return sessionId;
        }
    }

    private async storeToggles(toggles: IToggle[]): Promise<void> {
        this.toggles = toggles;
        this.emit(EVENTS.UPDATE);
        await this.storage.save(storeKey, toggles);
    }

    private async fetchToggles() {
        if (this.fetch) {
            try {
                const context = this.context;
                const urlWithQuery = new URL(this.url.toString());
                // Add context information to url search params. If the properties
                // object is included in the context, flatten it into the search params
                // e.g. /?...&property.param1=param1Value&property.param2=param2Value
                Object.entries(context).forEach(
                    ([contextKey, contextValue]) => {
                        if (contextKey === 'properties' && contextValue) {
                            Object.entries<string>(contextValue).forEach(
                                ([propertyKey, propertyValue]) =>
                                    urlWithQuery.searchParams.append(
                                        `properties[${propertyKey}]`,
                                        propertyValue
                                    )
                            );
                        } else {
                            urlWithQuery.searchParams.append(
                                contextKey,
                                contextValue
                            );
                        }
                    }
                );
                console.log('response');
                const response = await this.fetch(urlWithQuery.toString(), {
                    cache: 'no-cache',
                    headers: {
                        Authorization: this.clientKey,
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        'If-None-Match': this.etag,
                    }
                });
                if (response.ok && response.status !== 304) {
                    this.etag = response.headers.get('ETag') || '';
                    const data = await response.json();
                    await this.storeToggles(data.toggles);
                }
            } catch (e) {
                // tslint:disable-next-line
                console.error('Unleash: unable to fetch feature toggles', e);
                this.emit(EVENTS.ERROR, e);
            }
        }
    }
}

// export storage providers from root module
export { IStorageProvider, LocalStorageProvider, InMemoryStorageProvider };

export type { IConfig, IContext, IMutableContext, IVariant, IToggle };
