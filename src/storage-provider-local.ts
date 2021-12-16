import type IStorageProvider from './storage-provider';

export default class LocalStorageProvider implements IStorageProvider {
    private prefix = 'unleash:repository';

    public async save(name: string, data: any) {
        const repo = JSON.stringify(data);
        const key = `${this.prefix}:${name}`;
        try {
            await localStorage.setItem(key, repo);
        } catch (ex) {
            console.error(ex);
        }
    }

    public async get(name: string) {
        try {
            const key = `${this.prefix}:${name}`;
            const data = await localStorage.getItem(key);
            return data ? JSON.parse(data) : undefined;
        } catch (e) {
            // tslint:disable-next-line
            console.error(e);
        }
    }
}
