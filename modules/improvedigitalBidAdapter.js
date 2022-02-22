import {
  cleanObj, deepAccess, deepClone, deepSetValue, getBidIdParameter, getBidRequest, getDNT,
  getUniqueIdentifierStr, isFn, isNumber, isPlainObject, logWarn, mergeDeep, parseUrl
} from '../src/utils.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';
import {config} from '../src/config.js';
import {BANNER, NATIVE, VIDEO} from '../src/mediaTypes.js';
import {Renderer} from '../src/Renderer.js';
import {createEidsArray} from './userId/eids.js';

const BIDDER_CODE = 'improvedigital';
const RENDERER_URL = 'https://acdn.adnxs.com/video/outstream/ANOutstreamVideo.js';
const REQUEST_URL = 'https://ad.360yield.com/pb';
const CREATIVE_TTL = 300;

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
  VERSION: '1.2',
  ASSET_TYPES: {
    TITLE: 'title',
    IMG: 'img',
    DATA: 'data',
  },
  PARAMS: {
    title: {id: 0, name: 'title', assetType: 'title', default: {len: 140}},
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
  isBidRequestValid(bid) {
    return !!(bid && bid.params && (bid.params.placementId || (bid.params.placementKey && bid.params.publisherId)));
  },

  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {BidRequest[]} bidRequests A non-empty list of bid requests which should be sent to the Server.
   * @param bidderRequest
   * @return ServerRequest Info describing the request to the server.
   */
  buildRequests(bidRequests, bidderRequest) {
    const request = {
      id: getUniqueIdentifierStr(),
      cur: [config.getConfig('currency.adServerCurrency') || 'USD'],
      ext: {
        improvedigital: {
          sdk: {
            name: 'pbjs',
            version: '$prebid.version$',
          }
        }
      }
    };

    // Device
    request.device = (typeof config.getConfig('device') === 'object') ? config.getConfig('device') : {};
    request.device.w = request.device.w || window.innerWidth;
    request.device.h = request.device.h || window.innerHeight;
    if (getDNT()) {
      request.device.dnt = 1;
    }

    // Coppa
    const coppa = config.getConfig('coppa');
    if (typeof coppa === 'boolean') {
      deepSetValue(request, 'regs.coppa', ID_UTIL.toBit(coppa));
    }

    if (bidderRequest) {
      // GDPR
      const gdprConsent = deepAccess(bidderRequest, 'gdprConsent')
      if (gdprConsent) {
        if (typeof gdprConsent.gdprApplies === 'boolean') {
          deepSetValue(request, 'regs.ext.gdpr', ID_UTIL.toBit(gdprConsent.gdprApplies));
        }
        deepSetValue(request, 'user.ext.consent', gdprConsent.consentString);

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

      // Timeout
      deepSetValue(request, 'tmax', bidderRequest.timeout);
      // US Privacy
      deepSetValue(request, 'regs.ext.us_privacy', bidderRequest.uspConsent);
      // Site
      const url = config.getConfig('pageUrl') || deepAccess(bidderRequest, 'refererInfo.referer');
      const urlObj = parseUrl(url);
      deepSetValue(request, 'site.page', url);
      deepSetValue(request, 'site.domain', urlObj && urlObj.hostname);
    }

    // First party data
    const fpd = config.getConfig('ortb2');
    if (fpd) {
      if (fpd.site) {
        request.site = request.site ? {...request.site, ...fpd.site} : fpd.site;
      } else if (fpd.app) {
        request.app = fpd.app;
      }
    }

    const bidRequest0 = bidRequests[0];

    deepSetValue(request, 'source.ext.schain', bidRequest0.schain);
    deepSetValue(request, 'source.tid', bidRequest0.transactionId);

    if (bidRequest0.userId) {
      const eids = createEidsArray(bidRequest0.userId);
      deepSetValue(request, 'user.ext.eids', eids.length ? eids : undefined);
    }

    return ID_REQUEST.buildServerRequests(request, bidRequests, bidderRequest);
  },

  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {*} serverResponse A successful response from the server.
   * @param bidderRequest
   * @return {Bid[]} An array of bids which were nested inside the server.
   */
  interpretResponse(serverResponse, { bidderRequest }) {
    if (!Array.isArray(deepAccess(serverResponse, 'body.seatbid'))) {
      return [];
    }

    const bids = [];
    serverResponse.body.seatbid.forEach(seatbid => {
      if (!Array.isArray(seatbid.bid)) return;
      seatbid.bid.forEach(bidObject => {
        if (!bidObject.adm || !bidObject.price || bidObject.hasOwnProperty('errorCode')) {
          return;
        }
        const bidRequest = getBidRequest(bidObject.impid, [bidderRequest]);
        const bid = {
          requestId: bidObject.impid,
          cpm: bidObject.price,
          creativeId: bidObject.crid,
          currency: serverResponse.body.cur || 'USD',
          ttl: CREATIVE_TTL,
        }

        ID_RESPONSE.buildAd(bid, bidRequest, bidObject);

        const idExt = deepAccess(bidObject, `ext.${BIDDER_CODE}`);
        if (idExt) {
          ID_RESPONSE.fillDealId(bid, idExt);
          bid.netRevenue = idExt.is_net || false;
        }

        deepSetValue(bid, 'meta.advertiserDomains', bidObject.adomain);

        ID_RAZR.addBidData({
          bidRequest,
          bid
        });

        bids.push(bid);
      });
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
  getUserSyncs(syncOptions, serverResponses) {
    if (syncOptions.pixelEnabled) {
      const syncs = [];
      serverResponses.forEach(response => {
        const syncArr = deepAccess(response, `body.ext.${BIDDER_CODE}.sync`, []);
        syncArr.forEach(syncElement => {
          if (syncs.indexOf(syncElement) === -1) {
            syncs.push(syncElement);
          }
        });
      });
      return syncs.map(sync => ({ type: 'image', url: sync }));
    }
    return [];
  }
};

registerBidder(spec);

const ID_UTIL = {
  toBit(val) {
    return val ? 1 : 0;
  },

  isInstreamVideo(bid) {
    const context = deepAccess(bid, 'mediaTypes.video.context');
    return bid.mediaType === 'video' || context !== 'outstream';
  },

  isOutstreamVideo(bid) {
    return deepAccess(bid, 'mediaTypes.video.context') === 'outstream';
  },

  getBidFloor(bid) {
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

  // Convert [x, y] to { w: x, h: y}
  sizeToRtb(size) {
    return {w: size[0], h: size[1]};
  }
};

const ID_REQUEST = {
  buildServerRequests(requestObject, bidRequests, bidderRequest) {
    const requests = [];
    if (config.getConfig('improvedigital.singleRequest') === true) {
      requestObject.imp = bidRequests.map((bidRequest) => this.buildImp(bidRequest));
      requests[0] = this.formatRequest(requestObject, bidderRequest);
    } else {
      bidRequests.map((bidRequest) => {
        const request = deepClone(requestObject);
        request.id = bidRequest.bidId || getUniqueIdentifierStr();
        request.imp = [this.buildImp(bidRequest)];
        deepSetValue(request, 'source.tid', bidRequest.transactionId);
        requests.push(this.formatRequest(request, bidderRequest));
      });
    }

    return requests;
  },

  formatRequest(request, bidderRequest) {
    return {
      method: 'POST',
      url: REQUEST_URL,
      data: JSON.stringify(request),
      bidderRequest
    }
  },

  buildImp(bidRequest) {
    const imp = {
      id: getBidIdParameter('bidId', bidRequest) || getUniqueIdentifierStr(),
      secure: ID_UTIL.toBit(window.location.protocol === 'https:'),
    };

    // Floor
    const bidFloor = ID_UTIL.getBidFloor(bidRequest) || getBidIdParameter('bidFloor', bidRequest.params);
    if (bidFloor) {
      const bidFloorCur = getBidIdParameter('bidFloorCur', bidRequest.params) || 'USD';
      deepSetValue(imp, 'bidfloor', bidFloor);
      deepSetValue(imp, 'bidfloorcur', bidFloorCur ? bidFloorCur.toUpperCase() : undefined);
    }

    const placementId = getBidIdParameter('placementId', bidRequest.params);
    if (placementId) {
      deepSetValue(imp, 'ext.bidder.placementId', placementId);
    } else {
      deepSetValue(imp, 'ext.bidder.publisherId', getBidIdParameter('publisherId', bidRequest.params));
      deepSetValue(imp, 'ext.bidder.placementKey', getBidIdParameter('placementKey', bidRequest.params));
    }

    deepSetValue(imp, 'ext.bidder.keyValues', getBidIdParameter('keyValues', bidRequest.params));

    // Adding GPID
    const gpid = deepAccess(bidRequest, 'ortb2Imp.ext.gpid') ||
      deepAccess(bidRequest, 'ortb2Imp.ext.data.pbadslot') ||
      deepAccess(bidRequest, 'ortb2Imp.ext.data.adserver.adslot');

    deepSetValue(imp, 'ext.gpid', gpid);

    // Adding Interstitial Signal
    if (deepAccess(bidRequest, 'ortb2Imp.instl')) {
      imp.instl = 1;
    }

    const videoParams = deepAccess(bidRequest, 'mediaTypes.video');
    if (videoParams) {
      imp.video = this.buildVideoRequest(bidRequest);
      deepSetValue(imp, 'ext.is_rewarded_inventory', (videoParams.rewarded === 1 || deepAccess(videoParams, 'ext.rewarded') === 1) || undefined);
    }

    if (deepAccess(bidRequest, 'mediaTypes.banner')) {
      imp.banner = this.buildBannerRequest(bidRequest);
    }

    if (deepAccess(bidRequest, 'mediaTypes.native')) {
      imp.native = this.buildNativeRequest(bidRequest);
    }

    return imp;
  },

  buildVideoRequest(bidRequest) {
    const videoParams = deepClone(deepAccess(bidRequest, 'mediaTypes.video') || {});
    const videoImproveParams = deepAccess(bidRequest, 'params.video') || {};
    const video = {...videoParams, ...videoImproveParams};

    if (Array.isArray(video.playerSize)) {
      // Player size can be defined as [w, h] or [[w, h]]
      const size = Array.isArray(video.playerSize[0]) ? video.playerSize[0] : video.playerSize;
      video.w = size[0];
      video.h = size[1];
    }
    video.placement = ID_UTIL.isOutstreamVideo(bidRequest) ? VIDEO_PARAMS.PLACEMENT_TYPE.OUTSTREAM : VIDEO_PARAMS.PLACEMENT_TYPE.INSTREAM;

    // Mimes is required
    if (!video.mimes) {
      video.mimes = VIDEO_PARAMS.DEFAULT_MIMES;
    }

    Object.keys(video).forEach(prop => {
      if (VIDEO_PARAMS.SUPPORTED_PROPERTIES.indexOf(prop) === -1) delete video[prop];
    });
    return video;
  },

  buildBannerRequest(bidRequest) {
    // Set of desired creative sizes
    // Input Format: array of pairs, i.e. [[300, 250], [250, 250]]
    // Unless improvedigital.usePrebidSizes == true, no sizes are sent to the server
    // and the sizes defined in the server for the placement get used
    const banner = {};
    if (config.getConfig('improvedigital.usePrebidSizes') === true && bidRequest.sizes) {
      banner.format = bidRequest.sizes.map(ID_UTIL.sizeToRtb);
    }
    return banner;
  },

  buildNativeRequest(bidRequest) {
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
          required: ID_UTIL.toBit(cur.required),
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
    return { ver: NATIVE_DATA.VERSION, request: JSON.stringify(request) };
  },
};

const ID_RESPONSE = {
  buildAd(bid, bidRequest, bidResponse) {
    if (bidRequest.mediaTypes && Object.keys(bidRequest.mediaTypes).length === 1) {
      if (deepAccess(bidRequest, 'mediaTypes.video')) {
        this.buildVideoAd(bid, bidRequest, bidResponse);
      } else if (deepAccess(bidRequest, 'mediaTypes.banner')) {
        this.buildBannerAd(bid, bidRequest, bidResponse);
      } else if (deepAccess(bidRequest, 'mediaTypes.native')) {
        this.buildNativeAd(bid, bidRequest, bidResponse)
      }
    } else {
      if (bidResponse.adm.search(/^<vast/i) === 0) {
        this.buildVideoAd(bid, bidRequest, bidResponse);
      } else if (bidResponse.adm.indexOf('{') === 0) {
        this.buildNativeAd(bid, bidRequest, bidResponse);
      } else {
        this.buildBannerAd(bid, bidRequest, bidResponse);
      }
    }
  },

  buildVideoAd(bid, bidRequest, bidResponse) {
    bid.mediaType = VIDEO;
    bid.vastXml = bidResponse.adm;
    if (ID_UTIL.isOutstreamVideo(bidRequest)) {
      bid.adResponse = {
        content: bid.vastXml,
        height: bidResponse.h,
        width: bidResponse.w,
      }
      bid.renderer = ID_OUTSTREAM.createRenderer(bidRequest);
    }
  },

  buildBannerAd(bid, bidRequest, bidResponse) {
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

  buildNativeAd(bid, bidRequest, bidResponse) {
    bid.mediaType = NATIVE;
    const native = JSON.parse(bidResponse.adm)
    const nativeAd = {
      clickUrl: native.link.url,
    }
    // Trackers
    if (native.eventtrackers) {
      nativeAd.impressionTrackers = [];
      native.eventtrackers.forEach(tracker => {
        // Only handle impression event. Viewability events are not supported yet.
        if (tracker.event !== 1) return;
        switch (tracker.method) {
          case 1: // img
            nativeAd.impressionTrackers.push(tracker.url);
            break;
          case 2: // js
            // javascriptTrackers is a string. If there's more than one JS tracker in bid response, the last script will be used.
            nativeAd.javascriptTrackers = `<script src=\"${tracker.url}\"></script>`;
            break;
        }
      });
    } else {
      nativeAd.impressionTrackers = native.imptrackers || [];
      nativeAd.javascriptTrackers = native.jstracker;
    }
    deepSetValue(nativeAd, 'privacyLink', native.privacy);
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

  fillDealId(bid, idExt) {
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

const ID_OUTSTREAM = {
  renderer(bid) {
    bid.renderer.push(() => {
      window.ANOutstreamVideo.renderAd({
        sizes: [bid.width, bid.height],
        targetId: bid.adUnitCode,
        adResponse: bid.adResponse,
        rendererOptions: bid.renderer.getConfig()
      }, this.handleRendererEvents.bind(null, bid));
    });
  },

  handleRendererEvents(bid, id, eventName) {
    bid.renderer.handleVideoEvent({ id, eventName });
  },

  createRenderer(bidRequest) {
    const renderer = Renderer.install({
      id: bidRequest.adUnitCode,
      url: RENDERER_URL,
      loaded: false,
      config: deepAccess(bidRequest, 'renderer.options'),
      adUnitCode: bidRequest.adUnitCode
    });
    try {
      renderer.setRender(this.renderer);
    } catch (err) {
      logWarn('Prebid Error calling setRender on renderer', err);
    }
    return renderer;
  },
};

const ID_RAZR = {
  addBidData(data) {
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
  },

  isValidBid(bid) {
    return bid && /razr:\/\//.test(bid.ad);
  },

  render(bidId, event) {
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
  },

  addListenerOnce() {
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
};
