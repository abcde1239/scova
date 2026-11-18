"""Bing international search through the regional gateway, using the pinned native parser."""
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from searx.engines import ENGINE_DIR, load_module

_native = load_module('bing.py', ENGINE_DIR)
about = _native.about
categories = _native.categories
safesearch = _native.safesearch
paging = False
base_url = 'https://cn.bing.com'
search_locale = 'en-US'


def setup(_engine_settings):
    # Keep this engine named "bing" so SearxNG assigns its existing Bing traits.
    _native.traits = traits
    _native.base_url = base_url


def request(query, params):
    # A private native module avoids changing any other engine's request globals.
    locale = params.get('searxng_locale') or search_locale
    native_params = dict(params, searxng_locale=locale)
    _native.request(query, native_params)
    parts = urlsplit(native_params['url'])
    query_params = dict(parse_qsl(parts.query))
    query_params['ensearch'] = '1' if locale.lower().startswith('en') else '0'
    params['url'] = urlunsplit(parts._replace(query=urlencode(query_params)))
    return params


def response(resp):
    return _native.response(resp)
