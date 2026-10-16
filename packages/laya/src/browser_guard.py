"""What a request from a browser may ask laya-serve for. Kept free of the server's own imports so it can be tested alone.

A selector is judged by the adapter it resolves to, never by its spelling: "laya:@./priv_x" and "laya:@x/../priv_x" name
the same adapter as "laya:@priv_x". Adapter names are plain names (letters, digits, underscore, dot and hyphen, no
leading dot), so a path component cannot reach another folder.

The prefixes a browser may not use come from the registry's "browser_blocked_prefixes" list and the LAYA_BROWSER_BLOCKED_PREFIXES
variable (comma separated), never from this file, so the names of a person's own pilots stay out of the repository. They are
compared in lower case, because a case-insensitive filesystem treats two spellings as one directory. A registry that cannot be
read blocks every pilot request from a browser.
"""

import json
import os
import re

MAX_BROWSER_BODY = int(os.environ.get("LAYA_MAX_BROWSER_BODY", str(1024 * 1024)))
_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")


def valid_adapter_name(name):
    return isinstance(name, str) and bool(_NAME.match(name)) and ".." not in name


def adapter_dir(adapters_root, name):
    """The folder of an adapter, only when the name is a plain name and the folder really sits inside the adapters folder."""
    if not valid_adapter_name(name):
        raise ValueError("not a valid adapter name")
    path = os.path.join(adapters_root, name)
    root = os.path.realpath(adapters_root)
    real = os.path.realpath(path)
    if os.path.dirname(real) != root:
        raise ValueError("adapter folder is outside the adapters folder")
    return path


def _registry(path):
    """The registry as a dict, {} when there is none yet, None when it exists and cannot be read."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def blocked_prefixes(registry):
    found = [p for p in (registry or {}).get("browser_blocked_prefixes", []) if isinstance(p, str)]
    found += os.environ.get("LAYA_BROWSER_BLOCKED_PREFIXES", "").split(",")
    return tuple(p.strip().lower() for p in found if p.strip())


def selector_adapter(spec, registry_path):
    """The adapter a pilot selector (the text after 'laya:') resolves to, or None for the base model. Raises ValueError for a bad name."""
    if spec.startswith("@"):
        name = spec[1:]
        if not valid_adapter_name(name):
            raise ValueError("not a valid adapter name")
        return name
    registry = _registry(registry_path)
    if registry is None:
        raise ValueError("the registry cannot be read")
    pilots = registry.get("pilots")
    cfg = (pilots.get(spec) if isinstance(pilots, dict) else None) or {}
    name = cfg.get("adapter") if isinstance(cfg, dict) else None
    if name is not None and not valid_adapter_name(name):
        raise ValueError("not a valid adapter name")
    return name


def _blocked(name, prefixes):
    return isinstance(name, str) and bool(prefixes) and name.lower().startswith(prefixes)


def browser_may_use(model, registry_path):
    """(allowed, reason) for a request that came from a browser."""
    if not isinstance(model, str) or not model.startswith("laya:"):
        return True, None
    spec = model[5:]
    prefixes = blocked_prefixes(_registry(registry_path))
    if _blocked(spec, prefixes) or _blocked(spec[1:] if spec.startswith("@") else None, prefixes):
        return False, "That pilot is not available to browser requests"
    try:
        name = selector_adapter(spec, registry_path)
    except ValueError:
        return False, "That pilot or adapter name is not valid"
    if _blocked(name, prefixes):
        return False, "That pilot is not available to browser requests"
    return True, None


def body_too_large(content_length, received=0):
    """True when a declared length, or the bytes read so far, exceeds the browser body limit."""
    try:
        declared = int(content_length) if content_length is not None else 0
    except (TypeError, ValueError):
        return True
    return declared > MAX_BROWSER_BODY or received > MAX_BROWSER_BODY
