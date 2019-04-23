'use strict';

import * as Koa from 'koa';
import * as Aws from 'aws-sdk';

Aws.config.update({
  region: 'us-east-1',
  accessKeyId: process.env['AWS_ACCESS_KEY'],
  secretAccessKey: process.env['AWS_SECRET_KEY']
});

const CACHE_DURATION_MILLISECONDS = 60 * 4 * 60 * 1000;

const TABLE_NAME = 'rendertron-cache';

interface CacheItem {
  saved: string;
  path: string;
  expires: string;
  headers: string;
  payload: string;
}

export class DynamoCache {
  docClient: Aws.DynamoDB.DocumentClient = new Aws.DynamoDB.DocumentClient();

  // TODO(dave4506): create a clearCache function for utility use in the future
  async clearCache() {}

  async cacheContent(path: string, headers: {}, payload: Buffer) {
    console.log('caching', path);
    const now = new Date();
    const params = {
      TableName: TABLE_NAME,
      Item: {
        path,
        headers: JSON.stringify(headers),
        payload: JSON.stringify(payload),
        expires: new Date(
          now.getTime() + CACHE_DURATION_MILLISECONDS
        ).toString(),
        saved: now.toString()
      } as CacheItem
    };
    await this.docClient.put(params).promise();
  }

  async getCacheContent(path: string): Promise<CacheItem | null> {
    const params = {
      TableName: TABLE_NAME,
      Key: {
        path: path
      }
    };
    const data = await this.docClient.get(params).promise();
    return !!data ? (data.Item as CacheItem) : null;
  }

  middleware() {
    const cacheContent = this.cacheContent.bind(this);
    const getCacheContent = this.getCacheContent.bind(this);

    return async function(
      this: DynamoCache,
      ctx: Koa.Context,
      next: () => Promise<unknown>
    ) {
      const item = await getCacheContent(ctx.url);
      if (!!item) {
        if (new Date(item.expires).getTime() >= new Date().getTime()) {
          const headers = JSON.parse(item.headers);
          ctx.set(headers);
          ctx.set('x-rendertron-cached', new Date(item.saved).toUTCString());
          try {
            let payload = JSON.parse(item.payload);
            if (
              payload &&
              typeof payload === 'object' &&
              payload.type === 'Buffer'
            ) {
              payload = new Buffer(payload);
            }
            ctx.body = payload;
            console.log('using cache for', ctx.url);
            return;
          } catch (error) {
            console.log(
              'Erroring parsing cache contents, falling back to normal render'
            );
          }
        }
      }
      await next();
      if (ctx.status === 200) {
        cacheContent(ctx.url, ctx.response.headers, ctx.body);
      }
    };
  }
}
