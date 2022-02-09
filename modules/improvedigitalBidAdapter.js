import {
  cleanObj,
  deepAccess,
  deepClone,
  deepSetValue,
  getAdUnitSizes,
  getBidIdParameter,
  getBidRequest,
  getDNT,
  getUniqueIdentifierStr,
  isArray,
  isFn,
  isNumber,
  isPlainObject,
  logWarn, mergeDeep,
  parseGPTSingleSizeArrayToRtbSize
} from '../src/utils.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';
import {config} from '../src/config.js';
import {BANNER, NATIVE, VIDEO} from '../src/mediaTypes.js';
import {Renderer} from '../src/Renderer.js';
import {createEidsArray} from './userId/eids.js';

const BIDDER_CODE = 'improvedigital';
const RENDERER_URL = 'https://acdn.adnxs.com/video/outstream/ANOutstreamVideo.js';
const REQUEST_URL = 'https://ad.360yield.com/pb';

const VIDEO_PARAMS = {
  DEFAULT_MIMES: ['video/mp4'],
  SUPPORTED_PROPERTIES: ['mimes', 'minduration', 'maxduration', 'protocols', 'w', 'h', 'startdelay', 'placement', 'linearity', 'skip', 'skipmin',
    'skipafter', 'sequence', 'battr', 'maxextended', 'minbitrate', 'maxbitrate', 'boxingallowed', 'playbackmethod', 'playbackend', 'delivery', 'pos', 'companionad',
    'api', 'companiontype', 'ext'],
  PLACEMENT_TYPE: {
    INSTREAM: 1,
    OUTSTREAM: 3,
  }
};

const NATIVE_DATA = {
  ASSET_TYPES: {
    TITLE: 'title',
    IMG: 'img',
    DATA: 'data',
  },
  PARAMS: {
    title: {id: 0, name: 'title', assetType: 'title', default: {len: 50}},
    sponsoredBy: {id: 1, name: 'sponsoredBy', assetType: 'data', type: 1},
    icon: {id: 2, name: 'icon', assetType: 'img', type: 2},
    body: {id: 3, name: 'body', assetType: 'data', type: 2},
    image: {id: 4, name: 'image', assetType: 'img', type: 3},
    rating: {id: 5, name: 'rating', assetType: 'data', type: 3},
    likes: {id: 6, name: 'likes', assetType: 'data', type: 4},
    downloads: {id: 7, name: 'downloads', assetType: 'data', type: 5},
    price: {id: 8, name: 'price', assetType: 'data', type: 6},
    salePrice: {id: 9, name: 'salePrice', assetType: 'data', type: 7},
    phone: {id: 10, name: 'phone', assetType: 'data', type: 8},
    address: {id: 11, name: 'address', assetType: 'data', type: 9},
    body2: {id: 12, name: 'body2', assetType: 'data', type: 10},
    displayUrl: {id: 13, name: 'displayUrl', assetType: 'data', type: 11},
    cta: {id: 14, name: 'cta', assetType: 'data', type: 12},
  }
};

export const spec = {
  version: '7.6.0',
  code: BIDDER_CODE,
  gvlid: 253,
  aliases: ['id'],
  supportedMediaTypes: [BANNER, NATIVE, VIDEO],

  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param {object} bid The bid to validate.
   * @return boolean True if this is a valid bid, and false otherwise.
   */
  isBidRequestValid: function (bid) {
    return !!(bid && bid.params && (bid.params.placementId || (bid.params.placementKey && bid.params.publisherId)));
  },

  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {BidRequest[]} bidRequests A non-empty list of bid requests which should be sent to the Server.
   * @param bidderRequest
   * @return ServerRequest Info describing the request to the server.
   */
  buildRequests: function (bidRequests, bidderRequest) {
    // Configuration
    const currency = config.getConfig('currency.adServerCurrency');

    // Device related information
    const ua = navigator.userAgent;
    const language = ID_UTILITY.getLanguage();
    const h = screen.height;
    const w = screen.width;

    const request = {
      id: bidderRequest.auctionId,
      device: {ua, language, h, w, 'ip': '91.199.242.236'}, // @todo - remove IP address
      tmax: bidderRequest.timeout || 2000,
      cur: [currency || 'USD'],
      regs: {
        ext: {
          gdpr: 0,
        }
      },
    };

    // Impressions
    request.imp = bidRequests.map((bidRequest) => ID_REQUEST.buildImpression(bidRequest));

    // Coppa
    if (config.getConfig('coppa')) {
      deepSetValue(request, 'regs.coppa', 1);
    }

    // GDPR
    const gdprConsent = deepAccess(bidderRequest, 'gdprConsent')
    if (gdprConsent) {
      // GDPR Consent String
      deepSetValue(request, 'regs.ext.gdpr', gdprConsent.gdprApplies ? 1 : 0);
      if (gdprConsent.consentString) {
        deepSetValue(request, 'user.ext.consent', gdprConsent.consentString);
      }

      // Additional Consent String
      const additionalConsent = deepAccess(gdprConsent, 'addtlConsent');
      if (additionalConsent && additionalConsent.indexOf('~') !== -1) {
        // Google Ad Tech Provider IDs
        const atpIds = additionalConsent.substring(additionalConsent.indexOf('~') + 1);
        deepSetValue(
          request,
          'user.ext.consented_providers_settings.consented_providers',
          atpIds.split('.').map(id => parseInt(id, 10))
        );
      }
    }

    // US Privacy
    if (bidderRequest && bidderRequest.uspConsent) {
      deepSetValue(request, 'regs.ext.us_privacy', bidderRequest.uspConsent);
    }

    // Site Page
    if (bidderRequest && bidderRequest.refererInfo && bidderRequest.refererInfo.referer) {
      deepSetValue(request, 'site.page', bidderRequest.refererInfo.referer);
    }

    // Adding first party data
    const fpd = config.getConfig('ortb2');
    if (fpd) {
      if (fpd.site) {
        request.site = {...request.site, ...fpd.site};
      } else if (fpd.app) {
        request.app = fpd.app;
      }
      if (fpd.device) {
        request.device = {...request.device, ...fpd.device}
      }
      if (getDNT()) {
        request.device.dnt = 1;
      }
    }
    // End of adding first party data

    const bidRequest = bidRequests[0];

    if (bidRequest.schain) {
      deepSetValue(request, 'source.ext.schain', bidRequest.schain);
    }

    if (bidRequest.transactionId) {
      deepSetValue(request, 'source.tid', bidRequest.transactionId);
    }

    if (bidRequest.userId) {
      const eids = createEidsArray(bidRequest.userId);
      if (eids.length) {
        deepSetValue(request, 'user.ext.eids', eids);
      }
    }

    return {
      method: 'POST',
      url: REQUEST_URL,
      data: JSON.stringify(request),
      bidderRequest: bidderRequest
    };
  },

  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {*} serverResponse A successful response from the server.
   * @param bidderRequest
   * @return {Bid[]} An array of bids which were nested inside the server.
   */
  interpretResponse: function (serverResponse, { bidderRequest }) {
    if (!serverResponse.body) {
      return [];
    }
    const {seatbid, cur} = serverResponse.body;
    const bidResponses = [].concat(...seatbid.map(seat => seat.bid)).reduce((result, bid) => {
      result[bid.impid] = bid;
      return result;
    }, []);

    const bids = [];
    bidderRequest.bids.map((bidObject) => {
      const bidRequest = getBidRequest(bidObject.bidId, [bidderRequest]);
      const bidResponse = bidResponses[bidObject.bidId];
      if (bidResponse && bidResponse.adm && bidResponse.price) {
        const bid = {
          requestId: bidObject.bidId,
          cpm: bidResponse.price,
          creativeId: bidResponse.crid,
          currency: cur,
          ttl: 300,
        }

        ID_RESPONSE.buildAd(bidObject, bid, bidRequest, bidResponse);

        const idExt = deepAccess(bidResponse, 'ext.' + BIDDER_CODE);
        if (idExt) {
          ID_RESPONSE.fillDealId(bid, idExt);
        }
        bid.netRevenue = idExt.is_net || false;

        if (bidObject.adomain) {
          bid.meta = {
            advertiserDomains: bidObject.adomain
          }
        }

        Razr.addBidData({
          bidRequest,
          bid
        });

        bids.push(bid);
      }
    });

    return bids;
  },

  /**
   * Register the user sync pixels which should be dropped after the auction.
   *
   * @param {SyncOptions} syncOptions Which user syncs are allowed?
   * @param {ServerResponse[]} serverResponses List of server's responses.
   * @return {UserSync[]} The user syncs which should be dropped.
   */
  getUserSyncs: function(syncOptions, serverResponses) {
    if (syncOptions.pixelEnabled) {
      const syncs = [];
      serverResponses.forEach(response => {
        const ext = response.body.ext;
        if (ext && ext[BIDDER_CODE] && isArray(ext[BIDDER_CODE].sync)) {
          ext[BIDDER_CODE].sync.forEach(syncElement => {
            if (syncs.indexOf(syncElement) === -1) {
              syncs.push(syncElement);
            }
          });
        }
      });
      return syncs.map(sync => ({ type: 'image', url: sync }));
    }
    return [];
  }
};
registerBidder(spec);

const ID_UTILITY = {
  getLanguage: function () {
    return navigator.language.split('-')[0]
  },
  isInstreamVideo: function (bid) {
    const context = deepAccess(bid, 'mediaTypes.video.context');
    return bid.mediaType === 'video' || context !== 'outstream';
  },
  isOutstreamVideo: function (bid) {
    return deepAccess(bid, 'mediaTypes.video.context') === 'outstream';
  },
  getBidFloor: function (bid) {
    if (!isFn(bid.getFloor)) {
      return null;
    }
    const floor = bid.getFloor({
      currency: 'USD',
      mediaType: '*',
      size: '*'
    });
    if (isPlainObject(floor) && !isNaN(floor.floor) && floor.currency === 'USD') {
      return floor.floor;
    }
    return null;
  },
  outstreamRender: function (bid) {
    bid.renderer.push(() => {
      window.ANOutstreamVideo.renderAd({
        sizes: [bid.width, bid.height],
        targetId: bid.adUnitCode,
        adResponse: bid.adResponse,
        rendererOptions: bid.renderer.getConfig()
      }, ID_UTILITY.handleOutstreamRendererEvents.bind(null, bid));
    });
  },
  handleOutstreamRendererEvents: function (bid, id, eventName) {
    bid.renderer.handleVideoEvent({ id, eventName });
  },
  createRenderer: function (bidRequest) {
    const renderer = Renderer.install({
      id: bidRequest.adUnitCode,
      url: RENDERER_URL,
      loaded: false,
      config: deepAccess(bidRequest, 'renderer.options'),
      adUnitCode: bidRequest.adUnitCode
    });
    try {
      renderer.setRender(ID_UTILITY.outstreamRender);
    } catch (err) {
      logWarn('Prebid Error calling setRender on renderer', err);
    }
    return renderer;
  },
  getNormalizedBidRequest: function (bid) {
    let adUnitId = getBidIdParameter('adUnitCode', bid) || null;
    let placementId = getBidIdParameter('placementId', bid.params) || null;
    let publisherId = null;
    let placementKey = null;

    if (placementId === null) {
      publisherId = getBidIdParameter('publisherId', bid.params) || null;
      placementKey = getBidIdParameter('placementKey', bid.params) || null;
    }
    const keyValues = getBidIdParameter('keyValues', bid.params) || null;
    const singleSizeFilter = getBidIdParameter('size', bid.params) || null;
    const bidId = getBidIdParameter('bidId', bid);
    const transactionId = getBidIdParameter('transactionId', bid);
    const currency = config.getConfig('currency.adServerCurrency');

    let normalizedBidRequest = {};
    if (placementId) {
      normalizedBidRequest.placementId = placementId;
    } else {
      if (publisherId) {
        normalizedBidRequest.publisherId = publisherId;
      }
      if (placementKey) {
        normalizedBidRequest.placementKey = placementKey;
      }
    }

    if (keyValues) {
      normalizedBidRequest.keyValues = keyValues;
    }

    if (config.getConfig('improvedigital.usePrebidSizes') === true && !ID_UTILITY.isInstreamVideo(bid) && !ID_UTILITY.isOutstreamVideo(bid) && bid.sizes && bid.sizes.length > 0) {
      normalizedBidRequest.format = bid.sizes;
    } else if (singleSizeFilter && singleSizeFilter.w && singleSizeFilter.h) {
      normalizedBidRequest.size = {};
      normalizedBidRequest.size.h = singleSizeFilter.h;
      normalizedBidRequest.size.w = singleSizeFilter.w;
    }

    if (bidId) {
      normalizedBidRequest.id = bidId;
    }
    if (adUnitId) {
      normalizedBidRequest.adUnitId = adUnitId;
    }
    if (transactionId) {
      normalizedBidRequest.transactionId = transactionId;
    }
    if (currency) {
      normalizedBidRequest.currency = currency;
    }
    // Floor
    let bidFloor = ID_UTILITY.getBidFloor(bid);
    let bidFloorCur = null;
    if (!bidFloor) {
      bidFloor = getBidIdParameter('bidFloor', bid.params);
      bidFloorCur = getBidIdParameter('bidFloorCur', bid.params);
    }
    if (bidFloor) {
      normalizedBidRequest.bidFloor = bidFloor;
      normalizedBidRequest.bidFloorCur = bidFloorCur ? bidFloorCur.toUpperCase() : 'USD';
    }

    // GPID
    normalizedBidRequest.gpid = deepAccess(bid, 'ortb2Imp.ext.gpid') ||
      deepAccess(bid, 'ortb2Imp.ext.data.pbadslot') ||
      deepAccess(bid, 'ortb2Imp.ext.data.adserver.adslot');

    // Interstitial Signal
    normalizedBidRequest.interstitialSignal = deepAccess(bid, 'ortb2Imp.instl');

    return normalizedBidRequest;
  },
};

const ID_REQUEST = {
  buildImpression: function (bidRequest) {
    const placementObject = ID_UTILITY.getNormalizedBidRequest(bidRequest);
    const impressionObject = {
      id: placementObject.id || getUniqueIdentifierStr(),
      secure: window.location.protocol === 'https:' ? 1 : 0,
    };

    if (placementObject.bidFloor) {
      deepSetValue(impressionObject, 'bidfloor', placementObject.bidFloor);
    }
    if (placementObject.bidFloorCur) {
      deepSetValue(impressionObject, 'bidfloorcur', placementObject.bidFloorCur);
    }
    if (placementObject.placementId) {
      deepSetValue(impressionObject, 'ext.bidder.placementId', placementObject.placementId);
    }
    if (placementObject.placementKey) {
      deepSetValue(impressionObject, 'ext.bidder.placementKey', placementObject.placementKey);
    }
    if (placementObject.publisherId) {
      deepSetValue(impressionObject, 'ext.bidder.publisherId', placementObject.publisherId);
    }
    if (placementObject.keyValues) {
      deepSetValue(impressionObject, 'ext.bidder.keyValues', placementObject.keyValues);
    }
    // Adding GPID
    if (placementObject.gpid) {
      deepSetValue(impressionObject, 'ext.gpid', placementObject.gpid);
    }
    // Adding Interstitial Signal
    if (placementObject.interstitialSignal) {
      impressionObject.instl = placementObject.interstitialSignal;
    }

    const videoMedia = deepAccess(bidRequest, 'mediaTypes.video');
    if (videoMedia) {
      impressionObject.video = ID_REQUEST.buildVideoRequest(bidRequest);
      if (videoMedia.rewarded === 1 || deepAccess(videoMedia, 'ext.rewarded') === 1) {
        deepSetValue(impressionObject, 'ext.is_rewarded_inventory', true);
      }
    } else if (deepAccess(bidRequest, 'mediaTypes.banner')) {
      impressionObject.banner = ID_REQUEST.buildBannerRequest(bidRequest);
    } else if (deepAccess(bidRequest, 'mediaTypes.native')) {
      impressionObject.native = ID_REQUEST.buildNativeRequest(bidRequest);
    }

    return impressionObject;
  },
  buildVideoRequest: function (bidRequest) {
    let videoParams = deepClone(deepAccess(bidRequest, 'mediaTypes.video'));
    const videoParamsExt = deepAccess(bidRequest, 'params.video');

    if (isArray(videoParams.playerSize)) {
      const playerSize = videoParams.playerSize;
      videoParams.w = playerSize[0];
      videoParams.h = playerSize[1];
      videoParams.placement = ID_UTILITY.isOutstreamVideo(bidRequest) ? VIDEO_PARAMS.PLACEMENT_TYPE.OUTSTREAM : VIDEO_PARAMS.PLACEMENT_TYPE.INSTREAM;
    }

    if (videoParamsExt) videoParams = {...videoParams, ...videoParamsExt};

    // Mimes is required
    if (!videoParams.mimes) {
      videoParams.mimes = VIDEO_PARAMS.DEFAULT_MIMES;
    }

    const videoProperties = Object.keys(videoParams);

    videoProperties.forEach(prop => {
      if (VIDEO_PARAMS.SUPPORTED_PROPERTIES.indexOf(prop) === -1) delete videoParams[prop];
    });
    return videoParams;
  },
  buildBannerRequest: function (bidRequest) {
    const sizes = getAdUnitSizes(bidRequest);
    return {
      format: sizes.map(wh => parseGPTSingleSizeArrayToRtbSize(wh))
    };
  },
  buildNativeRequest: function (bidRequest) {
    const nativeRequest = bidRequest.mediaTypes.native;
    const request = {
      assets: [],
    }
    for (let i of Object.keys(nativeRequest)) {
      const cur = nativeRequest[i];
      const nativeItem = NATIVE_DATA.PARAMS[i];
      if (nativeItem) {
        const asset = {
          id: nativeItem.id,
          required: cur.required ? 1 : 0,
        };
        switch (nativeItem.assetType) {
          case NATIVE_DATA.ASSET_TYPES.TITLE:
            asset.title = {len: cur.len || nativeItem.default.len};
            break;
          case NATIVE_DATA.ASSET_TYPES.DATA:
            asset.data = cleanObj({type: nativeItem.type, len: cur.len})
            break;
          case NATIVE_DATA.ASSET_TYPES.IMG:
            const img = {
              type: nativeItem.type
            }
            if (cur.sizes) {
              [img.w, img.h] = cur.sizes;
            } else if (cur.aspect_ratios) {
              img.wmin = cur.aspect_ratios[0].min_width;
              img.hmin = cur.aspect_ratios[0].min_height;
            }
            asset.img = cleanObj(img);
            break;
          default:
            return;
        }
        request.assets.push(asset);
      }
    }
    return { request: JSON.stringify(request) };
  },
};

const ID_RESPONSE = {
  buildAd: function (bidObject, bid, bidRequest, bidResponse) {
    if (deepAccess(bidObject, 'mediaTypes.video')) {
      ID_RESPONSE.buildVideoAd(bid, bidRequest, bidResponse);
    } else if (deepAccess(bidObject, 'mediaTypes.banner')) {
      ID_RESPONSE.buildBannerAd(bid, bidRequest, bidResponse);
    } else if (deepAccess(bidObject, 'mediaTypes.native')) {
      ID_RESPONSE.buildNativeAd(bid, bidRequest, bidResponse)
    }
  },
  buildVideoAd: function (bid, bidRequest, bidResponse) {
    bid.mediaType = VIDEO;
    bid.vastXml = bidResponse.adm;
    if (ID_UTILITY.isOutstreamVideo(bidRequest)) {
      bid.adResponse = {
        content: bid.vastXml,
        height: bidResponse.h,
        width: bidResponse.w,
      }
      bid.renderer = ID_UTILITY.createRenderer(bidRequest);
    }
  },
  buildBannerAd: function (bid, bidRequest, bidResponse) {
    bid.mediaType = BANNER;
    if (bidResponse.nurl) {
      bid.nurl = bidResponse.nurl;
    }
    if (bidResponse.adm) {
      bid.ad = bidResponse.adm;
      bid.width = bidResponse.w;
      bid.height = bidResponse.h;
    }
  },
  buildNativeAd: function (bid, bidRequest, bidResponse) {
    bid.mediaType = NATIVE;
    const native = JSON.parse(bidResponse.adm)
    const nativeAd = {
      clickUrl: native.link.url,
      impressionTrackers: native.imptrackers,
      javascriptTrackers: native.jstracker ? [native.jstracker] : null,
    }
    if (native.privacy) {
      nativeAd.privacyLink = native.privacy;
    }
    const NATIVE_PARAMS_RESPONSE = {};
    Object.values(NATIVE_DATA.PARAMS).map(param => {
      NATIVE_PARAMS_RESPONSE[param.id] = param;
    });
    native.assets.map(asset => {
      const item = NATIVE_PARAMS_RESPONSE[asset.id];
      switch (item.assetType) {
        case NATIVE_DATA.ASSET_TYPES.TITLE:
          nativeAd.title = asset.title.text;
          break;
        case NATIVE_DATA.ASSET_TYPES.DATA:
          nativeAd[item.name] = asset.data.value;
          break;
        case NATIVE_DATA.ASSET_TYPES.IMG:
          nativeAd[item.name] = {
            url: asset.img.url,
            width: asset.img.w,
            height: asset.img.h,
          };
          break;
      }
    });
    bid.native = nativeAd;
  },
  fillDealId: function (bid, idExt) {
    // Deal ID_RESPONSE. Composite ads can have multiple line items and the ID_RESPONSE of the first
    // dealID line item will be used.
    const lineItemId = idExt.line_item_id;
    if (isNumber(lineItemId) && idExt.buying_type && idExt.buying_type !== 'rtb') {
      bid.dealId = lineItemId;
    } else if (Array.isArray(lineItemId) &&
      Array.isArray(idExt.buying_type) &&
      idExt.line_item_id.length === idExt.buying_type.length) {
      let isDeal = false;
      idExt.buying_type.forEach((bt, i) => {
        if (isDeal) return;
        if (bt && bt !== 'rtb') {
          isDeal = true;
          bid.dealId = idExt.lineItemId[i];
        }
      });
    }
  }
};

class Razr {
  static addBidData(data) {
    const {bid, bidRequest} = data || {};

    if (this.isValidBid(bid)) {
      const rendererConfig = mergeDeep(
        {},
        config.getConfig('improvedigital.rendererConfig'),
        deepAccess(bidRequest, 'params.rendererConfig')
      );

      this.bids = this.bids || {};
      this.bids[bid.requestId] = {
        ...data,
        adm: bid.ad,
        config: rendererConfig
      };

      bid.ad = `<script>window.top.postMessage({razrBidId: "${bid.requestId}"}, "*");</script>`;
      this.addListenerOnce();
    }
  }

  static isValidBid(bid) {
    return bid && /razr:\\?\/\\?\//.test(bid.ad);
  }

  static render(bidId, event) {
    const ns = window.razr = window.razr || {};
    ns.queue = ns.queue || [];

    ns.queue.push({
      ...this.bids[bidId],
      type: 'prebid',
      event
    });

    if (!this.loaded) {
      const s = document.createElement('script');
      s.type = 'text/javascript';
      s.async = true;
      s.src = 'https://razr.improvedigital.com/renderer.js';

      const x = document.getElementsByTagName('script')[0];
      x.parentNode.insertBefore(s, x);

      this.loaded = true;
    }
  }

  static addListenerOnce() {
    if (!this.listening) {
      window.addEventListener('message', event => {
        const bidId = deepAccess(event, 'data.razrBidId');
        if (bidId) {
          this.render(bidId, event);
        }
      });

      this.listening = true;
    }
  }
}
