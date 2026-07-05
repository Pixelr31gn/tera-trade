from app.brokers.base import (
    BrokerAccount,
    BrokerClient,
    BrokerOrder,
    BrokerPosition,
    HistoricalBar,
    OrderRequest,
    OrderResult,
    OrderSide,
    OrderType,
)
from app.brokers.simulated import SimulatedBroker

__all__ = [
    "BrokerAccount",
    "BrokerClient",
    "BrokerOrder",
    "BrokerPosition",
    "HistoricalBar",
    "OrderRequest",
    "OrderResult",
    "OrderSide",
    "OrderType",
    "SimulatedBroker",
]


def get_broker(kind: str) -> BrokerClient:
    """Factory: build the configured broker implementation."""
    if kind == "simulated":
        return SimulatedBroker()
    if kind == "projectx":
        from app.brokers.projectx import ProjectXGatewayBroker

        return ProjectXGatewayBroker()
    raise ValueError(f"Unknown broker kind: {kind}")
