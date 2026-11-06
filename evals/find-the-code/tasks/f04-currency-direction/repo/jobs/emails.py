"""Customer notifications."""
from string import Template

CONFIRMATION = Template("Hi $name, we received order $order and will ship it soon.")


def send_order_confirmation(mailer, customer: dict, order_id: str) -> None:
    body = CONFIRMATION.substitute(name=customer["first_name"], order=order_id)
    mailer.send(to=customer["email"], subject=f"Order {order_id} confirmed", body=body)


def send_shipping_update(mailer, customer: dict, tracking_number: str) -> None:
    mailer.send(to=customer["email"], subject="Your parcel is on its way", body=f"Tracking: {tracking_number}")
