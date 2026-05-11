package rabbitmq

import (
	"context"
	"log"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

type RabbitMQPublisher struct {
	connUrl string
}

func NewRabbitMQPublisher(url string) *RabbitMQPublisher {
	return &RabbitMQPublisher{connUrl: url}
}

// Publish implements the usecase.MessageBroker interface
func (p *RabbitMQPublisher) Publish(queueName string, message []byte) error {
	// Open connection with a timeout for High Availability
	conn, err := amqp.Dial(p.connUrl)
	if err != nil {
		return err
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		return err
	}
	defer ch.Close()

	q, err := ch.QueueDeclare(queueName, true, false, false, false, nil)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = ch.PublishWithContext(ctx,
		"",     // exchange
		q.Name, // routing key
		false,  // mandatory
		false,  // immediate
		amqp.Publishing{
			ContentType: "application/json",
			Body:        message,
		})

	if err == nil {
		log.Printf("Successfully published event to queue: %s", queueName)
	}
	return err
}
