import type { Api, Model } from "@mariozechner/pi-ai";

export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string>;
	  }
	| {
			ok: false;
			error: string;
	  };

export type RequestAuth = {
	apiKey?: string;
	headers?: Record<string, string>;
};

export type CompatibleModelRegistry = {
	find: (provider: string, modelId: string) => Model<Api> | undefined;
	hasConfiguredAuth?: (model: Model<Api>) => boolean;
	getApiKeyAndHeaders?: (model: Model<Api>) => Promise<ResolvedRequestAuth>;
	getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	getApiKey?: (model: Model<Api>) => Promise<string | undefined>;
};

export function hasResolvedHeaders(headers?: Record<string, string>): boolean {
	return !!headers && Object.keys(headers).length > 0;
}

export async function resolveModelAuth(
	modelRegistry: CompatibleModelRegistry,
	model: Model<Api>,
): Promise<ResolvedRequestAuth> {
	if (typeof modelRegistry.getApiKeyAndHeaders === "function") {
		return modelRegistry.getApiKeyAndHeaders(model);
	}

	if (typeof modelRegistry.getApiKey === "function") {
		const apiKey = await modelRegistry.getApiKey(model);
		return { ok: true, apiKey };
	}

	if (typeof modelRegistry.getApiKeyForProvider === "function") {
		const apiKey = await modelRegistry.getApiKeyForProvider(model.provider);
		return { ok: true, apiKey };
	}

	return { ok: false, error: "No supported auth resolution method on modelRegistry" };
}

export async function requireModelAuth(
	modelRegistry: CompatibleModelRegistry,
	provider: string,
	modelId: string,
	label: string,
): Promise<RequestAuth> {
	const model = modelRegistry.find(provider, modelId);
	if (!model) {
		throw new Error(`[OM] ${label} model not found: ${provider}/${modelId}`);
	}

	const auth = await resolveModelAuth(modelRegistry, model);
	if (!auth.ok) {
		throw new Error(`[OM] ${label} auth failed for ${provider}/${modelId}: ${auth.error}`);
	}

	if (!auth.apiKey && !hasResolvedHeaders(auth.headers)) {
		throw new Error(`[OM] No auth configured for ${label} model ${provider}/${modelId}`);
	}

	return {
		apiKey: auth.apiKey,
		headers: auth.headers,
	};
}
