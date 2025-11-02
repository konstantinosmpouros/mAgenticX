from apis.crud import router as crud_router
from apis.auth import router as auth_router
from apis.inference import router as inference_router
from apis.utils import router as utils_router

__all__ = [
    "crud_router",
    "auth_router",
    "inference_router",
    "utils_router",
]
