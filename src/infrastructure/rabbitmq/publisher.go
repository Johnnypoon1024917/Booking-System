package rabbitmq

import (
	"context"
	"encoding/json"
	"fsd-mrbs/src/domain/booking"
	"log"

	amqp "github.com/rabbitmq/amqp091-go"
)

type RabbitMQPublisher struct {
	connUrl string
}

func NewRabbitMQPublisher(url string) *RabbitMQPublisher {
	return &RabbitMQPublisher{connUrl: url}
}

func (p *RabbitMQPublisher) PublishBookingCreated(ctx context.Context, b *booking.Booking) error {
	conn, err := amqp.Dial(p.connUrl)
	if err != nil {
		log.Printf("Failed to connect to RabbitMQ: %v", err)
		return err
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		return err
	}
	defer ch.Close()

	q, err := ch.QueueDeclare("pimm_sync_queue", true, false, false, false, nil)
	if err != nil {
		return err
	}

	body, _ := json.Marshal(b)
	err = ch.PublishWithContext(ctx, "", q.Name, false, false, amqp.Publishing{
		ContentType: "application/json",
		Body:        body,
	})

	if err == nil {
		log.Printf("Event published to PIMM Queue: %s", b.ID)
	}
	return err
}
