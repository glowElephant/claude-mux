"""claude-mux — Python client for the muxd daemon."""

from .client import Client, Session
from .errors import BlockedError, MuxClientError, build_error_from_rpc
from .socket_path import default_socket_path

__version__ = "0.1.5"
__all__ = [
    "Client",
    "Session",
    "BlockedError",
    "MuxClientError",
    "build_error_from_rpc",
    "default_socket_path",
    "__version__",
]
